import './stream-board.ts';
import './podium-chart.ts';
import { keepRegionScroll } from './priority-list.ts';
import { createCelebrator, localSeenStore, priorityStatuses } from './priority-done.ts';
import './local-review.ts';
import './open-prs.ts';
import './draft-queue.ts';
import './scripts-view.ts';
import { h, s, shadow } from './dom.ts';
import { BOARD_CSS } from './stream-board.ts';
import { describeSources, loadCharts, loadCost, loadEpics, loadHome, loadLinkHosts, loadLocalReview, loadSeries, loadOpenPrs, loadOthersPrs, loadProjects, loadRefreshStatus, loadState } from './api.ts';
import { UpdateGate, askState } from './ask-state.ts';
import type { GateInput } from './ask-state.ts';
import { findByKey, focusKeyOf, foldStates, keepAcross, restoreFolds } from './keep-view.ts';
import type { FocusKey } from './keep-view.ts';
import { LiveUpdates, liveLabel } from './live.ts';
import type { LiveStatus } from './live.ts';
import { TEMPO_LEAD, TEMPO_SCALE, cueParts, cueTitle, clockTime, freshness, longDate, scoped, shortDate, tempoGloss, tempoWord } from './glance.ts';
import { parseDraftFocus, DASHBOARD, OPEN_PRS, OTHERS_PRS, SCRIPTS, formatFragment, streamTabId, isAllStreams, tabStream, tileId, nextTab, parseFilter, parseFragment, parseStreamFilter, tabIds } from './tabs.ts';
import { OpenPrsStore } from './open-prs-store.ts';
import { OthersPrsStore } from './others-prs-store.ts';
import { createOthersActions } from './others-api.ts';
import './others-prs.ts';
import { DraftsStore } from './drafts-store.ts';
import { waiting } from './drafts-model.ts';
import type { DraftRow } from './drafts-model.ts';
import { createDraftActions, loadDrafts } from './drafts-api.ts';
import { createPoster } from './write-token.ts';
import { GRID_CSS } from './grid.ts';
import { PAGER_CSS } from './pager-css.ts';
import { HOME_TAB_CSS, homeTab } from './home-tab.ts';
import { armHomeEntrance } from './home-motion.ts';
import { queueSize } from './local-review-widget.ts';
import { CHROME_CSS, baton, masthead, pickerOpen, streamPicker } from './home-chrome.ts';
import { shouldPulse, startAmbience, sweepPlayhead } from './home-ambience.ts';
import { streamScore, todayPanel } from './home-sections.ts';
import { seriesClass } from './series.ts';
import { conceptSection, streamVar, tacet } from './home-concept.ts';
import type { ProjectsLoad } from './home-tab.ts';
import { chipId, filteredView } from './filter-view.ts';
import { needsItems, needsSig } from './needs-items.ts';
import type { NeedsItem } from './needs-items.ts';
import type { CueKey } from './tabs.ts';
import type { Source } from './api.ts';
import type { AskBusyDetail, ChartsData, CostData, EpicsData, LocalReview, PodiumState, StreamHome } from './types.ts';

interface Fresh { state: PodiumState; charts: ChartsData; epics: EpicsData | null; cost: CostData | null; local: LocalReview | null; projects: ProjectsLoad; dropped: number; needsSig: string }

/** What the page has already celebrated, remembered across reloads; a priority is celebrated once, when it becomes done. */
const celebrator = createCelebrator(localSeenStore());

const CSS = `${GRID_CSS}${PAGER_CSS}${BOARD_CSS}${HOME_TAB_CSS}
  .wrap { max-width: var(--grid-max); margin: 0 auto; padding-inline: var(--page-pad); }

  /* Off screen until it has focus, then the first thing on the page; fixed so no layout moves. */
  .skip { position: fixed; inset-block-start: -100px; inset-inline-start: var(--space-3); z-index: 10; padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); background: var(--accent); color: var(--on-accent); font-weight: var(--weight-semibold); text-decoration: none; }
  .skip:focus-visible { inset-block-start: var(--space-3); outline: 2px solid var(--focus); outline-offset: 2px; }

  ${CHROME_CSS}
  .source { margin: var(--space-2) 0 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .fresh .short-hide { display: inline; }
  @media (max-width: 480px) { .fresh .short-hide { display: none; } [role=tabpanel] { padding-top: var(--space-5); } }
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
  .blk { color: var(--critical); font-size: var(--text-sm); }

  /* The counts: a glyph and a number before each word, the way the concept sets them. The tiles are still buttons that filter the board. */
  .cue { margin: var(--space-3) 0 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-5); padding: 0; list-style: none; color: var(--text-secondary); }
  .cue li { display: inline-flex; align-items: baseline; white-space: nowrap; }
  button.tile {
    font: inherit; color: inherit; background: none; border: 0; cursor: pointer;
    display: inline-flex; align-items: baseline; gap: var(--space-2); white-space: nowrap; min-height: 32px; align-self: center;
    padding: 0 var(--space-2); margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-sm);
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { button.tile:hover { background: var(--accent-soft); } }
  button.tile[aria-pressed=true] { background: var(--accent-soft); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.2em; }
  button.tile .g { font-size: 0.7em; }
  .tone-accent .g { color: var(--accent); } .tone-critical .g { color: var(--critical); } .tone-success .g { color: var(--success); } .tone-warning .g { color: var(--warning); }
  .filter-bar { margin: 0 0 var(--space-4); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .cue .n { font-family: var(--font-mono); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .cue .zero, .cue .zero .n { color: var(--text-muted); }
  .tempo-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-4); }
  button.tempo { font: inherit; font-family: var(--font-display); font-style: italic; font-size: var(--text-2xl); line-height: var(--leading-2xl); color: var(--text-primary); background: none; border: 0; padding: 0 var(--space-2); margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-sm); cursor: pointer; text-decoration: underline dotted var(--text-muted); text-underline-offset: 0.18em; text-decoration-thickness: 1px; }
  @media (hover: hover) { button.tempo:hover { background: var(--surface-2); } }
  .tempo-gloss { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .tempo-rule { margin: var(--space-2) 0 0; max-width: 62ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .tempo-rule[hidden] { display: none; }
  .tempo-rule i { font-family: var(--font-display); font-size: 1.04em; }
  .tempo-rule i.now { color: var(--text-primary); }
  .stream-title .tempo-line { margin-left: var(--space-2); }

  .badge { min-width: 20px; min-height: 20px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--accent-soft); color: var(--accent); font-size: var(--text-xs); line-height: 20px; font-weight: var(--weight-semibold); text-align: center; font-variant-numeric: tabular-nums; }
  .board { align-items: start; }
  .lead-grid { row-gap: var(--space-6); align-items: start; padding-bottom: var(--space-6); border-bottom: var(--hairline); margin-bottom: var(--space-7); }
  .lede { margin: var(--space-4) 0 0; max-width: 62ch; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
  .lede strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
  .stream-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-3); }
  .stream-title h2 { margin: 0; display: inline-flex; align-items: center; gap: var(--space-3); font-size: var(--text-xl); font-weight: var(--weight-semibold); letter-spacing: -0.012em; }
  .stream-title .projects-line { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .s1 { background: var(--series-1); } .s2 { background: var(--series-2); } .s3 { background: var(--series-3); } .s4 { background: var(--series-4); }
  .s5 { background: var(--series-5); } .s6 { background: var(--series-6); } .s7 { background: var(--series-7); } .s8 { background: var(--series-8); }
  .so { background: var(--series-other); }
  .stream-title .mark { width: 12px; height: 12px; border-radius: 3px; }
  /* Side by side (from 1100px), the priorities panel is one compact line per priority and takes the height it needs, top-aligned beside the headline. */
  @media (min-width: 1100px) { .lead-grid > priority-list { align-self: start; } }

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

  .fine { margin: var(--space-8) 0 0; display: flex; justify-content: flex-end; align-items: center; gap: var(--space-3); color: var(--text-secondary); }
  .fine .barline { fill: currentColor; width: 10px; height: 24px; color: var(--ink); }
  .fine i { font-family: var(--font-display); font-size: var(--text-2xl); }
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
  .sk-scope + .sk-staff { margin-top: 14px; }
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
  .sk-staff { position: relative; display: block; height: 25px; width: min(560px, 90%); margin-top: var(--space-5); }
  .sk-staff-line { position: absolute; left: 0; right: 0; height: 1px; background: var(--border-strong); opacity: 0.45; }
  .sk-staff-line:nth-child(2) { top: 6px; }
  .sk-staff-line:nth-child(3) { top: 12px; }
  .sk-staff-line:nth-child(4) { top: 18px; }
  .sk-staff-line:nth-child(5) { top: 24px; }
  .glide { position: absolute; inset: 0; animation: glide var(--dur-breathe) var(--ease-in-out) infinite alternate; }
  .sk-note { position: absolute; left: 0; top: 12.5px; width: 9px; height: 6px; border-radius: 50%; background: var(--text-muted); transform: rotate(-20deg); }
  @keyframes glide { to { transform: translateX(calc(100% - 9px)); } }
  @media (prefers-reduced-motion: reduce) { .glide { animation: none; } }
  @media (forced-colors: active) { .sk-staff-line, .sk-note { forced-color-adjust: none; background: CanvasText; } }
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
  #cost: CostData | null = null;
  // The local review queue; null when the server gave none, which the panel says in words.
  #local: LocalReview | null = null;
  #sources: { state: Source; charts: Source } = { state: 'fixture', charts: 'fixture' };
  #dropped = 0;
  #active = DASHBOARD;
  // Home's project rows load after the board, so the page answers at once and the rows fill in.
  #projects: ProjectsLoad = { state: 'loading' };
  // The summary tile pressed, if any: the board shows only that bucket. It lives in the fragment beside the tab.
  #filter: CueKey | null = null;
  // The stream chip pressed on the asks view, if any; it lives in the fragment too, so a reload keeps it.
  #stream: string | null = null;
  #tick: number | undefined;
  #tabsObserver: ResizeObserver | null = null;
  #tempoOpen = false;
  #stopAmbience: (() => void) | null = null;
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
  // The draft queue's data and what is being typed live here too (see drafts-store.ts); every decision goes to the server, which alone posts.
  readonly #drafts = new DraftsStore({ load: () => loadDrafts(), send: (op, payload, comments) => createDraftActions().send(op, payload, comments) });
  // The Others' PRs tab's own writes (ignore, un-ignore, review anyway); each reloads the list on success, so the row reflects the server's word.
  readonly #othersActions = createOthersActions();
  // The Others' PRs tab's list of every open teammate PR (the server reads its cache; it never calls GitHub per request).
  readonly #others = new OthersPrsStore(loadOthersPrs);
  // The fingerprint of the needs-you rows on screen, and the store subscriptions that watch for a change in them.
  #shownSig = '';
  readonly #unfollow: (() => void)[] = [];
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
    const stream = filter === 'asks' ? parseStreamFilter(location.hash) : null;
    if (id === this.#active && filter === this.#filter && stream === this.#stream) return;
    if (id === this.#active) {   // only the filter moved: stay where the reader is
      if (filter === this.#filter) this.#setStream(stream, false); else this.#setFilter(filter, null, stream);
      return;
    }
    this.#filter = filter;
    this.#stream = stream;
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
    Promise.all([loadState(), loadCharts(), loadEpics(), loadLocalReview(), loadLinkHosts(), loadSeries(), loadCost()]).then(async ([s, c, e, lr, , , co]) => {
      if (!this.isConnected) return;   // removed while loading: start nothing that disconnectedCallback has already missed
      // The tab's count and Home's needs-you list read these two stores; the queue's own file is watched, so later changes come through the live load below.
      if (s.source === 'server') await Promise.all([this.#drafts.load(), this.#prs.load()]);
      if (!this.isConnected) return;
      this.#state = s.data;
      this.#charts = c.data;
      this.#epics = s.source === 'server' ? e : null;
      this.#cost = s.source === 'server' ? co : null;
      this.#local = s.source === 'server' ? lr : null;
      this.#sources = { state: s.source, charts: c.source };
      this.#dropped = s.dropped + c.dropped;
      this.#active = parseFragment(location.hash, this.#ids());
      this.#filter = parseFilter(location.hash);
      this.#stream = this.#filter === 'asks' ? parseStreamFilter(location.hash) : null;
      this.#safeRender();
      // A few small gestures from the score (a note hops, the pendulum ticks), paused while an answer is being typed or the stream menu is open, and spent after a dozen.
      this.#stopAmbience = startAmbience(this.#root, () => typingAnAnswer() || pickerOpen());
      // The data is loaded once; re-say its age every minute so a page left open shows when it has gone stale.
      this.#tick = window.setInterval(() => this.#updateFreshness(), 60_000);
      if (this.#live) {   // sample data has no server to follow
        this.#shownSig = this.#needsSig(s.data);
        this.#startLive(`${s.data.seq}|${this.#shownSig}`);
        this.#followNeeds();
      }
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
    for (const off of this.#unfollow.splice(0)) off();
    this.#liveUpdates = null;
    this.#tabsObserver?.disconnect();
    this.#stopAmbience?.();
    this.#stopAmbience = null;
  }

  /** Follow the server: the event stream, or polling when there is none. Only ever with data from a real server. */
  #startLive(seq: string): void {
    this.#liveUpdates = new LiveUpdates<Fresh>({
      open: () => (typeof EventSource === 'undefined' ? null : new EventSource('/api/events')),
      load: async () => {
        // A decision or a new draft changes drafts.jsonl, and a PR refresh the PR cache, not the board, so the board's own seq may not move: `needsSig` stands in for them.
        await Promise.all([this.#drafts.load(), this.#prs.load(), this.#others.load()]);
        const [s, c, e, lr, p, co] = await Promise.all([loadState(), loadCharts(), loadEpics(), loadLocalReview(), projectsLoad(true), loadCost()]);
        return s.source === 'server' && c.source === 'server' ? { state: s.data, charts: c.data, epics: e, cost: co, local: lr, projects: p, dropped: s.dropped + c.dropped, needsSig: this.#needsSig(s.data) } : null;
      },
      seqOf: (f) => `${f.state.seq}|${f.needsSig}`,
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
    this.#shownSig = f.needsSig;
    this.#state = f.state;
    this.#charts = f.charts;
    this.#epics = f.epics;
    this.#cost = f.cost;
    this.#local = f.local;
    this.#projects = f.projects;
    this.#dropped = f.dropped;
    askState.prune(f.state.asks.map((a) => a.id));
    if (!this.#ids().includes(this.#active)) this.#active = DASHBOARD;   // the stream behind the open tab is gone
    const focused = this.#focusKey();
    const folds = foldStates(this.#root);
    const putScrollBack = keepRegionScroll(this.#root);
    this.#safeRender();
    putScrollBack();   // the new priorities region starts at the top; return it to where the reader had scrolled
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
    if (id === DASHBOARD) armHomeEntrance();   // coming back to Home plays its entrance again; a live redraw does not
    this.#writeFragment(id);
    this.#safeRender();
    if (focusTab) this.#root.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
  }

  #writeFragment(id: string): void {
    const next = formatFragment(id, this.#filter, this.#stream);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  /** Show only one tile's items, or everything for null. A redraw destroys the tile, so focus goes back to `refocus`'s tile. */
  #setFilter(key: CueKey | null, refocus: CueKey | null, stream: string | null = null): void {
    if (key === this.#filter) return;
    this.#release({ busy: false });   // this render replaces any card still saving
    this.#filter = key;
    this.#stream = key === 'asks' ? stream : null;
    this.#writeFragment(this.#active);
    this.#safeRender();
    if (refocus) this.#root.querySelector<HTMLElement>(`button.tile[data-key="${refocus}"]`)?.focus();
  }

  /** Narrow the asks view to one stream, or back to All for null. Focus returns to the same chip, which the redraw replaced. */
  #setStream(stream: string | null, refocus = true): void {
    if (stream === this.#stream) return;
    this.#release({ busy: false });   // this render replaces any card still saving
    this.#stream = stream;
    this.#writeFragment(this.#active);
    this.#safeRender();
    if (!refocus) return;
    const chips = [...this.#root.querySelectorAll<HTMLElement>('button.fchip')];
    (chips.find((b) => b.id === chipId(this.#stream)) ?? chips.find((b) => b.id === chipId(null)))?.focus();
  }

  /** Redraw after a Home board control changed. Focus returns to the same control, which the redraw replaced. */
  #redrawKeepingFocus(): void {
    const ctl = this.#root.activeElement?.getAttribute('data-ctl') ?? null;
    this.#release({ busy: false });   // this render replaces any card still saving
    this.#safeRender();
    if (ctl) this.#root.querySelector<HTMLElement>(`[data-ctl="${ctl}"]`)?.focus();
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
    // The streams live in the picker; the tab list holds the views, and the open stream's own tab while one is open, so the panel always has a tab to name it.
    const ids = this.#ids().filter((id) => isAllStreams(id) || id === this.#active);
    const count = <T extends { stream: string }>(xs: T[], id: string): number => (isAllStreams(id) ? xs.length : xs.filter((x) => x.stream === tabStream(id)).length);
    const tabs = ids.map((id) => {
      const on = id === this.#active;
      const stream = tabStream(id);
      const n = isAllStreams(id) ? 0 : count(st.asks, id);
      const prs = id === OPEN_PRS ? st.prs.length : 0;
      const label = id === DASHBOARD ? 'Home' : id === OPEN_PRS ? 'Open PRs' : id === OTHERS_PRS ? 'Others\' PRs' : id === SCRIPTS ? 'Scripts' : stream ?? id;
      const tab = h('button', {
        type: 'button', role: 'tab', id: tabDomId(id), 'aria-selected': String(on), 'aria-controls': 'panel',
        tabindex: on ? '0' : '-1', class: stream ? streamVar(stream) : undefined,
      },
      stream ? h('span', { class: 'sw', 'aria-hidden': 'true' }) : null,
      label,
      prs > 0 ? h('span', { class: 'count' }, String(prs)) : null,
      id === OTHERS_PRS && this.#waitingDrafts('review') > 0 ? h('span', { class: 'count' }, String(this.#waitingDrafts('review')), h('span', { class: 'vh' }, ' awaiting')) : null,
      id === OPEN_PRS && this.#waitingDrafts('reply') > 0 ? h('span', { class: 'count' }, String(this.#waitingDrafts('reply')), h('span', { class: 'vh' }, ' replies awaiting')) : null,
      n > 0 ? h('span', { class: 'count' }, String(n), h('span', { class: 'vh' }, ' awaiting')) : null);
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
    const stream = tabStream(this.#active);
    const panel = h('div', { role: 'tabpanel', id: 'panel', 'aria-labelledby': tabDomId(this.#active), tabindex: '0', class: 'wrap page' },
      this.#active === OPEN_PRS || this.#active === OTHERS_PRS || this.#active === SCRIPTS ? null : this.#pageHead(st, stream),
      this.#filter ? this.#filtered(st, this.#filter) : this.#active === DASHBOARD ? this.#home(st) : this.#active === OPEN_PRS ? this.#openPrs(st) : this.#active === OTHERS_PRS ? this.#othersPrs() : this.#active === SCRIPTS ? this.#scripts() : this.#board(st, stream ?? ''),
      fine());
    const tablist = h('div', { role: 'tablist', 'aria-label': 'Views' }, ...tabs);
    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Podium' }, tablist);
    this.#root.replaceChildren(this.#skipLink(panel), this.#titlePage(st), this.#tabRow(st, tabbar), h('main', {}, panel));
    this.#watchTabOverflow(tabbar, tablist);
    showCue(this.#waiting(st));
    // The playhead sweeps the staves once as Home appears (the same render that plays its entrance).
    if (this.#active === DASHBOARD && this.#root.querySelector('.home.enter')) sweepPlayhead(this.#root);
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

  /** The title page: the wordmark (a link Home on every tab), today's date, the data's freshness and Refresh. */
  #titlePage(st: PodiumState): HTMLElement {
    const note = this.#live && this.#dropped === 0 ? '' : describeSources(this.#sources.state, this.#sources.charts, this.#dropped, st.generatedAt);
    const waiting = this.#waiting(st);
    const head = masthead({
      home: this.#homeLink(st, waiting),
      status: [this.#freshness(st), this.#link()],
      live: this.#live,
      refresh: async () => { await this.#liveUpdates?.refresh(); },
    });
    if (note) head.append(h('p', { class: 'source' }, note));
    return head;
  }

  /** The sticky bar under the title page: the views as tabs, and the stream picker beside them. */
  #tabRow(st: PodiumState, nav: HTMLElement): HTMLElement {
    const open = tabStream(this.#active);
    const voices = [{ stream: null, name: 'All streams', n: st.asks.length }, ...st.streams.map((s) => ({ stream: s, name: s, n: st.asks.filter((a) => a.stream === s).length }))];
    const pick = streamPicker({ voices, current: open, pick: (stream) => this.#select(stream === null ? DASHBOARD : streamTabId(stream), true) });
    return h('div', { class: 'tabbar-wrap' }, h('div', { class: 'wrap tabbar-row' }, nav, pick));
  }

  /** The wordmark is a real link to Home, on every tab; it shares the global focus ring. */
  #homeLink(st: PodiumState, waiting: number): HTMLElement {
    const a = h('a', { class: 'wordmark-link', href: formatFragment(DASHBOARD), title: 'Podium home' },
      baton(waiting > 0, shouldPulse(waiting)),
      h('span', { class: 'name' }, h('span', { class: 'word' }, 'Podium'), h('span', { class: 'scope' }, longDate(st.today) || shortDate(st.today))));
    a.addEventListener('click', (e) => { e.preventDefault(); this.#select(DASHBOARD, true); });
    return a;
  }

  /** The cue line for Home and a stream tab. Open PRs draws its own. Counts follow the open tab. */
  #pageHead(st: PodiumState, stream: string | null): HTMLElement {
    const buckets = scoped(st, stream);
    const { tempo, rule, gloss } = this.#tempo({ asks: buckets.asks.length, blocked: buckets.blocked.length, working: buckets.working.length });
    const parts = cueParts(buckets, this.#needsFor(st, stream).length);
    // A glyph before each count, as the score marks them: a dot for a cue, a triangle for a held part, a tick for shipped, a half moon for in flight.
    const GLYPH: Record<CueKey, [string, string]> = { asks: ['●', 'accent'], blocked: ['▲', 'warning'], done: ['✓', 'success'], working: ['◐', 'neutral'] };
    const cue = parts.map((p) => {
      const [glyph, tone] = GLYPH[p.key];
      const tile = h('button', { type: 'button', class: 'tile', id: tileId(p.key), 'data-key': p.key, 'aria-pressed': String(p.key === this.#filter) },
        h('span', { class: 'g', 'aria-hidden': 'true' }, glyph), h('span', { class: 'n' }, String(p.n)), p.label);
      tile.addEventListener('click', () => this.#setFilter(p.key === this.#filter ? null : p.key, p.key));
      return h('li', { class: `tone-${tone}${p.n === 0 ? ' zero' : ''}` }, tile);
    });
    const oldest = Math.max(0, ...buckets.asks.map((a) => a.ageDays));
    const stale = buckets.asks.filter((a) => a.ageDays > 3).length;
    const oneWay = buckets.asks.filter((a) => a.door === 'one-way').length;
    const queued = st.queued.filter((q) => stream === null || q.stream === stream).length;
    const lead = h('div', { class: 'cue-line' },
      stream ? h('div', { class: 'stream-title' }, h('h2', { id: 'scope' }, h('span', { class: `mark ${seriesClass(stream)}`, 'aria-hidden': 'true' }), stream),
        this.#projectNames(stream) ? h('span', { class: 'projects-line' }, this.#projectNames(stream)) : null) : null,
      h('div', { class: 'tempo-line' }, tempo, gloss),
      h('ul', stream ? { class: 'cue', role: 'list', 'aria-labelledby': 'scope' } : { class: 'cue', role: 'list', 'aria-label': 'All streams' }, ...cue),
      rule,
      buckets.asks.length ? h('p', { class: 'lede' }, 'The oldest ask has waited ', h('strong', {}, `${oldest} ${oldest === 1 ? 'day' : 'days'}`), stale ? `, and ${stale} ${stale === 1 ? 'is' : 'are'} past the 3 day mark` : '', '. ', oneWay ? `${oneWay} ${oneWay === 1 ? 'is a one-way door' : 'are one-way doors'}. ` : '', `${queued} ${queued === 1 ? 'task is' : 'tasks are'} queued behind your answers.`) : null);
    if (this.#filter) return lead;
    lead.classList.add('two-thirds');
    const side = stream === null ? this.#priorities(st) : todayPanel(st.priorities.state === 'ok' ? st.priorities.items : [], this.#projects.state === 'ok' ? this.#projects.data : null, stream);
    side.classList.add('third');
    return h('section', { class: 'grid pair lead-grid' }, lead, side);
  }

  /** The project names a stream's rows cover, as one mono line; empty until the projects payload has loaded or when it lists none. */
  #projectNames(stream: string): string {
    return this.#projects.state === 'ok' ? (this.#projects.data.rows.find((r) => r.stream === stream)?.projects ?? []).join(' · ') : '';
  }

  #priorities(st: PodiumState): HTMLElement {
    const pri = st.priorities;
    const editable = this.#sources.state === 'server';
    const stale = pri.state === 'stale' && pri.date !== st.today;
    const note = stale
      ? `Priorities are from ${longDate(pri.date) || pri.date}. ${editable ? 'Add one to start today\'s list.' : 'Set today\'s with journal.ts priorities set.'}`
      : 'No priorities set for today.';
    const priorities = h('priority-list');
    const items = pri.state === 'ok' ? pri.items : [];
    const statuses = priorityStatuses(items, st.footer, st.done);
    priorities.data = { items, max: st.prioritiesMax, streams: st.streams, editable, note, progress: { statuses, celebration: celebrator.observe(st.today, statuses), tz: st.tz } };
    return priorities;
  }

  /** The tempo word for the scope's counts, as a button that opens the rule behind it in place (no tooltip, no modal), with a one-line gloss beside it. */
  #tempo(counts: { asks: number; blocked: number; working: number }): { tempo: HTMLElement; rule: HTMLElement; gloss: HTMLElement } {
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
    return { tempo, rule, gloss: h('p', { class: 'tempo-gloss' }, tempoGloss(t.word)) };
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
    const score = streamScore(st, this.#charts, stream);
    return score ? h('div', { class: 'grid stream-page' }, board, score) : board;
  }

  /** Fetch the stream's home base and hand it to the board that asked; a board redrawn in the meantime is a different element and is left alone. */
  async #loadHome(stream: string, board: HTMLElementTagNameMap['stream-board']): Promise<void> {
    const got = await loadHome(stream);
    if (!got) return;
    this.#homes.set(stream, got.data);
    if (board.isConnected) board.home = got.data;
  }

  /**
   * PRs ready to merge and reviews waiting for an OK, for the needs-you list. Read from the Open PRs and draft stores (the PR cache and
   * `drafts.jsonl`, so no GitHub call), only on a real server: sample data never lists a PR or a draft.
   */
  #needs(st: PodiumState): NeedsItem[] {
    return this.#sources.state === 'server' ? needsItems(this.#prs.model.data, this.#drafts.model.data, st.prs, st.streams, st.generatedAt) : [];
  }

  /**
   * The needs-you rows read the Open PRs and draft stores, which change on their own (the Refresh press on the Open PRs tab, a decision on
   * a draft) without a board event. When what the rows say has changed, show it through the same gate as a live update, so a press or a
   * half-typed answer is never redrawn under the person.
   */
  #followNeeds(): void {
    const changed = (): void => {
      const st = this.#state;
      if (!st || !this.isConnected || !this.#charts) return;
      const sig = this.#needsSig(st);
      if (sig === this.#shownSig) return;
      this.#adopt({ state: st, charts: this.#charts, epics: this.#epics, cost: this.#cost, local: this.#local, projects: this.#projects, dropped: this.#dropped, needsSig: sig });
    };
    this.#unfollow.push(this.#prs.subscribe(changed), this.#drafts.subscribe(changed));
  }

  /** What the needs-you rows say, as one string, so a live load notices a changed draft or PR cache that left the board's own seq alone. */
  #needsSig(st: PodiumState): string { return needsSig(needsItems(this.#prs.model.data, this.#drafts.model.data, st.prs, st.streams, st.generatedAt)); }

  /** Home's needs-you list carries them; a stream tab keeps its own board, so its count and filter leave them out. */
  #needsFor(st: PodiumState, stream: string | null): NeedsItem[] { return stream === null ? this.#needs(st) : []; }

  /** The pressed tile's bucket for the open tab, from the same scoped buckets the tile counts. */
  #filtered(st: PodiumState, key: CueKey): Node {
    const stream = tabStream(this.#active);
    const label = cueParts(scoped(st, stream), this.#needsFor(st, stream).length).find((p) => p.key === key)?.label ?? key;
    return filteredView(scoped(st, stream), key, label, {
      live: this.#sources.state === 'server',
      ctx: { now: st.generatedAt, tz: st.tz, showStream: stream === null, prs: st.prs },
      clear: () => this.#setFilter(null, key),
      stream: this.#stream,
      setStream: (s) => this.#setStream(s),
      extra: this.#needsFor(st, stream),
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
    const localList = h('local-review');
    localList.review = this.#local;   // the one copy of the queue, the same one Home's widget counts from
    return tabPage(el, this.#replyDrafts(),
      conceptSection('rehearsal', { instrument: 'Rehearsal', title: 'Waiting for local review', n: queueSize(this.#local) || null }, localList));
  }

  /** Drafts still waiting for a decision, for the tab's count. */
  #waitingDrafts(source: 'review' | 'reply'): number { return (this.#drafts.model.data?.drafts ?? []).filter((d) => d.source === source && waiting(d)).length; }

  /** The draft queue as an element wired to the page's store; each draw asks the server again, so the tab never shows older drafts than the file holds. */
  #draftQueue(sources: ReadonlyArray<'review' | 'reply'>, empty: string, load = true): HTMLElementTagNameMap['draft-queue'] {
    const el = h('draft-queue');
    const s = this.#drafts;
    el.sources = sources;
    el.emptyText = empty;
    el.actions = { startEdit: (id) => s.startEdit(id), startReject: (id) => s.startReject(id), cancel: (id) => s.cancel(id), setBuffer: (id, t) => s.setBuffer(id, t), setComment: (id, i, t) => s.setComment(id, i, t), saveEdit: (id) => { void s.saveEdit(id); }, approve: (id) => { void s.approve(id); }, approveAsComment: (id) => { void s.approve(id, 'comment'); }, reject: (id) => { void s.reject(id); } };
    el.model = s.model;
    const unsubscribe = s.subscribe(() => { if (!el.isConnected) { unsubscribe(); return; } el.model = s.model; });
    if (load && this.#sources.state === 'server') void s.load();
    return el;
  }

  /** Under the Open PRs table: drafted replies to other people's comments on your own PRs, one section per PR. Approve posts the reply as you; nothing posts before that. */
  #replyDrafts(): Node {
    return conceptSection('replies', { instrument: 'Replies', title: 'Drafted replies', hint: 'Replies drafted to people\'s comments on your PRs. Nothing is posted until you press Approve; Edit changes the wording first, Reject records why and posts nothing.' },
      this.#draftQueue(['reply'], 'No replies are waiting for your approval.'));
  }

  /** The draft queue as an element wired to the page's store, without its own load: the caller redraws on the store's changes, so a load here would loop. */
  #queueView(match: (d: DraftRow) => boolean, empty: string, quiet: boolean, authorOf: (d: DraftRow) => string | undefined): HTMLElementTagNameMap['draft-queue'] {
    const el = this.#draftQueue(['review'], empty, false);
    el.match = match;
    el.quiet = quiet;
    el.authorOf = authorOf;
    return el;
  }

  /** The Others' PRs tab: every open teammate PR with its review-draft status, and the drafted review comments inline. Approve posts as you; Reject records why and posts nothing. */
  #othersPrs(): Node {
    const el = h('others-prs');
    el.focusDraft = parseDraftFocus(location.hash);
    const draw = (): void => {
      el.model = this.#others.model;
      el.drafts = { rows: this.#drafts.model.data?.drafts.filter((d) => d.source === 'review') ?? null, queue: (match, empty, quiet, authorOf) => this.#queueView(match, empty, quiet, authorOf) };
    };
    el.actions = { run: async (op, p) => { const out = await this.#othersActions.send(op, p); if (out === null) await this.#others.load(); return out; } };
    draw();
    const stops: Array<() => void> = [];
    const redraw = (): void => { if (!el.isConnected) { for (const off of stops.splice(0)) off(); return; } draw(); };
    stops.push(this.#others.subscribe(redraw), this.#drafts.subscribe(redraw));
    if (this.#sources.state === 'server') void this.#others.load();   // each draw asks again, so the tab never shows an older list than the cache holds
    return tabPage(conceptSection('others', { instrument: 'The orchestra', title: 'Others\' PRs', hint: 'Every open PR by a teammate, newest activity first. Where a review comment is drafted, it sits under the PR. Nothing is posted until you press Approve; Edit changes the wording first, Reject records why and posts nothing.' }, el));
  }

  /** The Scripts tab: the catalog of scripts the server can run. Sample data has no server to run them. */
  #scripts(): Node {
    return tabPage(conceptSection('scripts', { instrument: 'Repertoire', title: 'Scripts' },
      this.#sources.state === 'server' ? h('scripts-view') : tacet('Scripts run on the server, which this page is not connected to.', 'tacet')));
  }

  /** The landing tab (its id stays `dashboard`, so old links keep working). Asks answer in place; everything else links on. */
  #home(st: PodiumState): Node {
    return homeTab(st, this.#charts, { live: this.#sources.state === 'server', projects: this.#projects, epics: this.#epics, cost: this.#cost, local: this.#local, needs: this.#needs(st), redraw: () => this.#redrawKeepingFocus() });
  }
}

/** A tab's body: the shared grid, each child a full-width section. */
function tabPage(...children: Node[]): HTMLElement {
  return h('div', { class: 'grid tab-page' }, ...children);
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
      h('div', { class: 'grid pair board' },
        h('div', { class: 'sk-stack two-thirds' }, line('120px'), h('span', { class: 'sk-hint' }, line('340px')), rows(['62%', '48%', '55%', '40%']), line('96px'), rows(['44%'])),
        h('div', { class: 'sk-stack third' }, line('110px'), rows(['80%', '66%', '72%'])))));
}

/** The cue line's placeholder: a five-line staff with one note head gliding along it while the board loads. */
function staff(): HTMLElement {
  return h('span', { class: 'sk-staff', 'aria-hidden': 'true' },
    ...[0, 1, 2, 3, 4].map(() => h('span', { class: 'sk-staff-line' })),
    h('span', { class: 'glide' }, h('span', { class: 'sk-note' })));
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
