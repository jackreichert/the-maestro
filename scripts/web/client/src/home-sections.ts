/** The pieces of the Home tab, each drawn from what home-model works out: score table, needs-you board, deck, epics and notes. */
import { h, refLink, streamTag } from './dom.ts';
import { askCards, itemRows } from './stream-board.ts';
import { needsRows } from './needs-view.ts';
import { scopedItems } from './needs-items.ts';
import type { NeedsItem } from './needs-items.ts';
import type { AskList, RowContext } from './stream-board.ts';
import { byPriority, clockTime, splitStream, todaysPriorities } from './glance.ts';
import { linkAttrs } from './link-policy.ts';
import { STATE_TONE, askAgeBars, byStreamName, epicCards, orderAsks, prGauge, queuedByStream } from './home-model.ts';
import { scoreTable } from './home-model.ts';
import type { AskOrder, CiKey, EpicCard, Score, ScoreRow } from './home-model.ts';
import { seriesClass } from './series.ts';
import { OPEN_PRS, formatFragment } from './tabs.ts';
import type { ChartsData, EpicsData, ProjectsData, HomeLink, PodiumState } from './types.ts';

/** Asks listed before "Show all N", and shipped items before the same. */
const ASK_CAP = 6;
const SHIPPED_CAP = 6;
const LINK_KIND: Record<HomeLink['kind'], string> = { pin: 'pinned', context: 'context', library: 'library' };

/** What the reader picked on the board. Kept at module level so a live refresh redraws Home with the same sort, filter and reveal. */
export const homeUi: { order: AskOrder; stream: string | null; allAsks: boolean; allShipped: boolean } = { order: 'oldest', stream: null, allAsks: false, allShipped: false };

export const HOME_SECTIONS_CSS = `
  .home-plus { display: grid; gap: var(--space-8, 4rem); }
  .sec-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2) var(--space-4); padding-bottom: var(--space-3); border-bottom: var(--hairline-strong, var(--hairline)); margin-bottom: var(--space-3); }
  .sec-head h2 { margin: 0; display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-lg); line-height: var(--leading-lg); font-weight: var(--weight-semibold); letter-spacing: -0.011em; }
  .sec-head .n { font-family: var(--font-display); font-size: 1.5rem; font-weight: 400; line-height: 1; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .sec-head .aside { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .sec-head .aside a { white-space: nowrap; }
  .empty-line { margin: 0; padding: var(--space-3) 0; color: var(--text-muted); font-size: var(--text-sm); border-top: var(--hairline); }
  .empty-line i { font-family: var(--font-serif); font-size: 1.04em; color: var(--text-secondary); }

  /* The score: one staff per stream, a note for each of the last 14 days. */
  .score-table { list-style: none; margin: 0; padding: 0; }
  .score-line { display: grid; grid-template-columns: minmax(150px, 190px) minmax(0, 1fr) repeat(4, 3.25rem) 8.5rem; gap: 0 var(--space-3); align-items: center; }
  .score-line.hd { padding-bottom: var(--space-2); border-bottom: var(--hairline-strong, var(--hairline)); font-size: var(--text-xs); color: var(--text-muted); }
  .score-line.hd .num { text-align: right; }
  .score-line.hd .today { color: var(--accent); font-weight: var(--weight-semibold); }
  li.score-line { padding-block: var(--space-3); border-bottom: var(--hairline); }
  .daycols, .score-staff { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); }
  .daycols span { text-align: center; }
  .daycols .wk { text-align: left; }
  .score-name { display: grid; gap: 2px; min-width: 0; }
  .score-name .nm { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: var(--weight-semibold); }
  .mark-sq { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .score-name .nm a { padding-block: 2px; margin-block: -2px; }
  .score-name .sub { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .score-staff { position: relative; height: 40px; background: repeating-linear-gradient(to bottom, transparent 0 7px, var(--border-strong) 7px 8px); border-right: 3px double var(--text-primary); }
  .score-cell { position: relative; }
  .score-cell.wk { border-left: 1px solid var(--text-primary); }
  .score-cell.today { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .score-note { position: absolute; left: 50%; width: 10px; height: 7px; border-radius: 50%; transform: translateX(-50%) rotate(-20deg); }
  .score-note.p1 { bottom: 3px; } .score-note.p2 { bottom: 10px; } .score-note.p3 { bottom: 17px; } .score-note.p4 { bottom: 25px; }
  .score-rest { position: absolute; left: 50%; top: 15px; width: 8px; height: 3px; background: var(--text-muted); transform: translateX(-50%); opacity: 0.6; }
  .stat { text-align: right; font-variant-numeric: tabular-nums; font-size: var(--text-sm); color: var(--text-primary); }
  .stat.zero { color: var(--text-muted); }
  .state-pill { justify-self: end; padding: 2px var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-xs); line-height: var(--leading-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-secondary); }
  .state-pill.attention { background: var(--accent-soft); color: var(--accent); }
  .state-pill.critical { background: var(--critical-soft); color: var(--critical); }
  .state-pill.success { background: var(--success-soft); color: var(--success); }
  .score-key { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: var(--space-3) 0 0; padding: 0; list-style: none; font-size: var(--text-xs); color: var(--text-muted); }
  .score-key li { display: inline-flex; align-items: center; gap: 6px; }
  .k-note { width: 11px; height: 8px; border-radius: 50%; background: var(--text-secondary); transform: rotate(-22deg); }
  .k-rest { width: 9px; height: 3px; background: var(--text-muted); opacity: 0.6; }
  .k-bar { width: 1px; height: 12px; background: var(--text-primary); }
  @media (max-width: 1000px) {
    .score-line { grid-template-columns: repeat(4, minmax(0, 1fr)) auto; }
    .score-line.hd { display: none; }
    .score-line > .score-name { grid-column: 1 / -1; margin-bottom: var(--space-2); }
    .score-line > .score-staff { grid-column: 1 / -1; margin-bottom: var(--space-2); }
    .stat { text-align: left; }
  }

  /* The board: asks on the left, what blocks and what runs on the right. */
  .needs-how { margin: 0 0 var(--space-3); max-width: 70ch; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); }
  .seg { display: inline-flex; padding: 2px; border-radius: var(--radius-md); background: var(--surface-2); }
  .seg button { font: inherit; font-size: var(--text-sm); min-height: 28px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm); background: none; color: var(--text-secondary); cursor: pointer; }
  .seg button[aria-pressed=true] { background: var(--surface-1); color: var(--text-primary); box-shadow: var(--shadow-1); }
  .chips-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0 0 var(--space-3); padding: 0; list-style: none; }
  .fchip { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 28px; padding: 0 var(--space-3); border: var(--hairline); border-radius: var(--radius-pill); background: var(--surface-1); font: inherit; font-size: var(--text-sm); color: var(--text-secondary); cursor: pointer; }
  .fchip i { width: 8px; height: 8px; border-radius: 50%; }
  .fchip .c { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .fchip[aria-pressed=true] { background: var(--text-primary); border-color: var(--text-primary); color: var(--surface-page); }
  .fchip[aria-pressed=true] .c { color: inherit; }
  .more-row { display: flex; justify-content: center; padding-top: var(--space-4); }
  .more-row button.more { margin: 0; padding: 0 var(--space-4); min-height: 36px; border: var(--hairline-strong, var(--hairline)); background: var(--surface-1); color: var(--text-primary); }
  .side-block + .side-block { margin-top: var(--space-6); }
  .queue-line { margin: var(--space-3) 0 var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
  .queue-line strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .qbar { display: flex; height: 8px; border-radius: 2px; overflow: hidden; gap: 1px; margin-bottom: var(--space-3); }
  .qbar span { display: block; min-width: 3px; }
  ul.qlist { list-style: none; margin: 0; padding: 0; }
  ul.qlist li { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); padding-block: var(--space-2); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  ul.qlist .nm { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: var(--weight-semibold); }
  .deck { display: grid; gap: var(--space-7) var(--space-7); align-items: start; }
  @media (min-width: 1100px) { .deck { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); } }
  ul.shipped { list-style: none; margin: 0; padding: 0; display: grid; gap: 0 var(--space-6); border-top: var(--hairline); }
  @media (min-width: 700px) { ul.shipped { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  ul.shipped > li { padding-block: var(--space-3); border-bottom: var(--hairline); font-size: var(--text-sm); line-height: var(--leading-sm); }
  ul.shipped > li[hidden] { display: none; }
  .shipped-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-primary); }
  .shipped-meta { display: flex; align-items: baseline; gap: var(--space-3); margin-top: var(--space-1); color: var(--text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .gauges { display: grid; gap: var(--space-6); }
  .gauge h3 { margin: 0 0 var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .gauge h3 .n { font-weight: var(--weight-regular); color: var(--text-muted); }
  .gauge .cap { margin: 0 0 var(--space-3); font-size: var(--text-sm); color: var(--text-muted); }
  .bars { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) 2.5rem; gap: var(--space-2) var(--space-3); align-items: center; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); }
  .bars li { display: contents; }
  .bars .track { height: 8px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .bars .fill { display: block; height: 100%; background: var(--accent); }
  .bars .stale .fill { background: var(--warning); }
  .bars .v { text-align: right; font-variant-numeric: tabular-nums; }
  .cibar { display: flex; height: 10px; border-radius: 2px; overflow: hidden; gap: 1px; background: var(--surface-2); }
  .cibar span { display: block; min-width: 3px; }
  .ci-pass { background: var(--success); } .ci-pending { background: var(--warning); } .ci-fail { background: var(--critical); } .ci-none { background: var(--text-muted); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: var(--space-3) 0 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
  .legend li { display: inline-flex; align-items: center; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .legend i { width: 8px; height: 8px; border-radius: 2px; }
  .facts3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0 0; }
  .facts3 div { font-size: var(--text-sm); color: var(--text-secondary); }
  .facts3 b { display: block; font-family: var(--font-display); font-size: 1.75rem; font-weight: 400; line-height: 1.1; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .facts3 .warn b { color: var(--warning); }

  ul.ecards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .ecard { display: grid; min-width: 0; overflow-wrap: anywhere; gap: var(--space-3); align-content: start; height: 100%; padding: var(--space-4); border: var(--hairline); border-radius: var(--radius-md); background: var(--surface-1); }
  .ecard-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  /* A stream tab's own staff: the same score, drawn large, with each day's count underneath. */
  .big-staff .daycols { margin-bottom: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
  .big-staff .score-staff { height: 80px; background: repeating-linear-gradient(to bottom, transparent 0 15px, var(--border-strong) 15px 16px); }
  .big-staff .score-note { width: 14px; height: 10px; }
  .big-staff .score-note.p1 { bottom: 4px; } .big-staff .score-note.p2 { bottom: 20px; } .big-staff .score-note.p3 { bottom: 36px; } .big-staff .score-note.p4 { bottom: 52px; }
  .big-staff .score-rest { top: 31px; width: 12px; height: 4px; }
  .tally { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); margin-top: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; text-align: center; }
  .today-panel h2 { margin: 0 0 var(--space-3); padding-bottom: var(--space-2); border-bottom: var(--hairline-strong); font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-secondary); }
  .today-panel p { margin: 0 0 var(--space-3); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .today-panel .rk { color: var(--text-muted); }
  .today-panel i { font-family: var(--font-serif); font-size: 1.04em; }
  .ecard-top .nm { display: inline-flex; white-space: nowrap; align-items: center; gap: var(--space-2); }
  .ecard-top .id { font-weight: var(--weight-regular); }
  .ecard-title { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); }
  .ecard-title a { padding-block: 0; }
  .ecard-n { font-size: var(--text-sm); color: var(--text-secondary); }
  .ecard-n b { font-family: var(--font-display); font-size: 1.75rem; font-weight: 400; color: var(--text-primary); margin-right: var(--space-2); font-variant-numeric: tabular-nums; }
  .ecard-n .bl { margin-left: var(--space-2); color: var(--critical); font-weight: var(--weight-semibold); }
  .seg-bar { display: flex; width: 100%; height: 6px; border-radius: 2px; overflow: hidden; background: var(--surface-2); }
  .seg-bar span { display: block; }
  .sg-closed { background: var(--accent); } .sg-progress { background: var(--series-2); } .sg-blocked { background: var(--critical); } .sg-open { background: transparent; }
  .ecard-next { margin: 0; font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .notes-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: var(--space-4) 0 0; padding: 0; list-style: none; font-size: var(--text-xs); color: var(--text-muted); }
  .notes-row a { display: inline-block; padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--surface-2); font-family: var(--font-mono); color: var(--text-primary); text-decoration: none; }
  .notes-row a:hover { text-decoration: underline; }
  .library-none { margin: var(--space-4) 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  @media (forced-colors: active) {
    .seg button { border: 1px solid ButtonText; }
    .seg button[aria-pressed=true], .fchip[aria-pressed=true] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
    .score-staff { forced-color-adjust: none; background-image: repeating-linear-gradient(to bottom, transparent 0 7px, GrayText 7px 8px); }
    .big-staff .score-staff { background-image: repeating-linear-gradient(to bottom, transparent 0 15px, GrayText 15px 16px); }
    .score-note, .k-note, .k-bar { forced-color-adjust: none; background: CanvasText; }
    .score-rest, .k-rest { forced-color-adjust: none; background: GrayText; opacity: 1; }
    .bars .fill, .cibar span, .seg-bar span, .qbar span, .fchip i { forced-color-adjust: none; background: Highlight; outline: 1px solid CanvasText; }
  }
`;

export const secHead = (title: string, n: number, aside?: Node | string | null, extra?: Node | null): HTMLElement =>
  h('div', { class: 'sec-head' },
    h('h2', {}, title, n > 0 ? h('span', { class: 'n' }, h('span', { class: 'vh' }, ', '), String(n)) : null),
    aside ? h('p', { class: 'aside' }, aside) : null, extra ?? null);

let seq = 0;
/** A section element named by its heading, so a screen reader lists the parts of Home. */
export function part(cls: string, head: HTMLElement, ...body: (Node | null)[]): HTMLElement {
  const id = `hp${++seq}`;
  head.querySelector('h2')?.setAttribute('id', id);
  return h('section', { class: cls, 'aria-labelledby': id }, head, ...body);
}
/** A bar segment sized by weight: CSSOM, not a style attribute, so the CSP holds. Zero-weight segments are not drawn. */
export function grow(cls: string, weight: number): HTMLElement {
  const el = h('span', { class: cls });
  el.style.flexGrow = String(weight);
  el.style.flexBasis = '0';
  return el;
}
/** A gauge fill, `ratio` of its track wide. */
function fill(ratio: number): HTMLElement {
  const el = h('span', { class: 'fill' });
  el.style.width = `${Math.round(ratio * 100)}%`;
  return el;
}
export const empty = (text: string, rest?: string): HTMLElement => h('p', { class: 'empty-line' }, text, rest ? ' ' : null, rest ? h('i', {}, rest) : null);

// ---- The score ----

/** One staff per stream for the last 14 chart days: pitch is a few steps, so a class carries it and no inline style is needed. */
export function scoreSection(score: Score): HTMLElement {
  const labels = h('span', { class: 'daycols' }, ...score.days.map((d) => h('span', { class: `${d.today ? 'today' : ''}${d.label.length > 1 ? ' wk' : ''}`.trim() || undefined }, d.today ? 'Today' : d.label)));
  const header = h('li', { class: 'score-line hd', 'aria-hidden': 'true' }, h('span', {}, 'Stream'), labels, ...['Asks', 'Queued', 'PRs', '14 d'].map((t) => h('span', { class: 'num' }, t)), h('span', {}));
  const rows = score.rows.map((r) => scoreRow(r, score));
  return part('score', secHead('Streams, last 14 days', 0, 'Each line is a stream. Higher notes mean more tasks finished that day.'),
    h('ul', { class: 'score-table', role: 'list' }, header, ...rows),
    h('ul', { class: 'score-key', role: 'list' },
      h('li', {}, h('i', { class: 'k-note', 'aria-hidden': 'true' }), 'Tasks done that day'),
      h('li', {}, h('i', { class: 'k-rest', 'aria-hidden': 'true' }), 'Nothing finished'),
      h('li', {}, h('i', { class: 'k-bar', 'aria-hidden': 'true' }), 'Week starts'),
      h('li', {}, 'Open a stream for its full board.')));
}

function scoreRow(r: ScoreRow, score: Score): HTMLElement {
  const cls = seriesClass(r.stream);
  const stat = (n: number, what: string): HTMLElement => h('span', { class: `stat${n === 0 ? ' zero' : ''}` }, h('span', { class: 'vh' }, `${what} `), String(n));
  const cells = score.days.map((d, i) => h('span', { class: `score-cell${d.weekStart ? ' wk' : ''}${d.today ? ' today' : ''}` },
    r.pitches[i] ? h('span', { class: `score-note p${r.pitches[i]} ${cls}` }) : h('span', { class: 'score-rest' })));
  return h('li', { class: 'score-line' },
    h('span', { class: 'score-name' },
      h('span', { class: 'nm' }, streamTag(r.stream)),
      r.projects.length ? h('span', { class: 'sub' }, r.projects.join(', ')) : null),
    h('span', { class: 'score-staff', role: 'img', 'aria-label': `${r.stream}, tasks finished per day: ${score.days.map((d, i) => `${d.date} ${r.days[i]}`).join(', ')}` }, ...cells),
    stat(r.asks, 'Asks'), stat(r.queued, 'Queued'), stat(r.prs, 'Open PRs'), stat(r.total, 'Finished in 14 days'),
    h('span', { class: `state-pill ${STATE_TONE[r.state]}` }, r.state));
}

// ---- Needs you, with Blocked and In flight beside it ----

/**
 * The board: the asks (sortable, filterable by stream, capped), then the PRs ready to merge and the reviews waiting for an OK (`extra`),
 * and the two side panels. The stream chips count and filter both. `redraw` rebuilds Home after a control changes.
 */
export function boardSection(st: PodiumState, live: boolean, redraw: () => void, extra: NeedsItem[] = []): HTMLElement {
  const total = st.asks.length + extra.length;
  const picked = homeUi.stream && [...st.asks, ...extra].some((a) => a.stream === homeUi.stream) ? homeUi.stream : null;
  const shown = picked ? st.asks.filter((a) => a.stream === picked) : st.asks;
  const shownExtra = picked ? scopedItems(extra, picked) : extra;
  const cap = homeUi.allAsks ? Number.POSITIVE_INFINITY : ASK_CAP;
  const list: AskList | null = askCards(shown, live, true, cap, (xs) => {
    const ranked = byPriority(orderAsks(xs, homeUi.order === 'stream' ? 'oldest' : homeUi.order), todaysPriorities(st));
    return homeUi.order === 'stream' ? byStreamName(ranked) : ranked;
  });
  const set = (patch: Partial<typeof homeUi>): void => { Object.assign(homeUi, patch); redraw(); };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Order of asks' },
    ...([['oldest', 'Oldest first'], ['oneway', 'One-way doors first'], ['stream', 'Stream']] as const).map(([k, label]) => {
      const b = h('button', { type: 'button', 'data-ctl': `order-${k}`, 'aria-pressed': String(homeUi.order === k) }, label);
      b.addEventListener('click', () => set({ order: k }));
      return b;
    }));
  const chip = (stream: string | null, n: number): HTMLElement => {
    const b = h('button', { type: 'button', class: 'fchip', 'data-ctl': `chip-${stream ?? 'all'}`, 'aria-pressed': String(picked === stream) },
      stream ? h('i', { class: seriesClass(stream), 'aria-hidden': 'true' }) : null, stream ?? 'All', ' ', h('span', { class: 'c' }, String(n)));
    b.addEventListener('click', () => set({ stream, allAsks: false }));
    return h('li', {}, b);
  };
  const byStream = st.streams.map((s) => ({ s, n: st.asks.filter((a) => a.stream === s).length + extra.filter((x) => x.stream === s).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const more = list && shown.length > ASK_CAP
    ? (() => {
      const b = h('button', { type: 'button', class: 'more', 'data-ctl': 'more-asks', 'aria-expanded': String(homeUi.allAsks) }, homeUi.allAsks ? 'Show fewer' : `Show all ${shown.length}`, h('span', { class: 'vh' }, ' asks'), h('span', { class: 'chev', 'aria-hidden': 'true' }));
      b.addEventListener('click', () => set({ allAsks: !homeUi.allAsks }));
      return h('div', { class: 'more-row' }, b);
    })()
    : null;
  const needs = part('needs', secHead('Needs you', total, null, seg),
    h('p', { class: 'needs-how' }, live ? 'Open an ask to see its context and the orchestrator\'s recommendation. Send an answer, take the recommendation, or skip a two-way door; it is saved to the ledger and leaves the board on the next update. Asks tied to the first priority of the day come first; PRs ready to merge and reviews waiting for your OK follow them.' : 'Sample data: asks open read-only. Answering needs the Podium server.'),
    byStream.length > 1 ? h('ul', { class: 'chips-row', role: 'list', 'aria-label': 'Filter what needs you by stream' }, chip(null, total), ...byStream.map((x) => chip(x.s, x.n))) : null,
    list ? list.list : shownExtra.length ? null : empty('Nothing needs you right now.', 'tacet'), more, needsRows(shownExtra, true));
  return h('div', { class: 'board' }, h('div', { class: 'col' }, needs), h('div', { class: 'col' }, sidePanels(st)));
}

function sidePanels(st: PodiumState): HTMLElement {
  const ctx: RowContext = { now: st.generatedAt, tz: st.tz, showStream: true, prs: st.prs };
  const queued = queuedByStream(st.queued, st.streams);
  const flight = h('div', {},
    st.working.length ? itemRows(st.working, ctx) : empty('No agent is running.', 'rest'),
    st.queued.length ? h('p', { class: 'queue-line' }, h('strong', {}, String(st.queued.length)), ' queued, waiting for a free lane') : null,
    st.queued.length ? h('div', { class: 'qbar', 'aria-hidden': 'true' }, ...queued.map((q) => grow(seriesClass(q.stream), q.n))) : null,
    st.queued.length ? h('ul', { class: 'qlist', role: 'list', 'aria-label': 'Queued by stream' }, ...queued.map((q) => h('li', {}, h('span', { class: 'nm' }, streamTag(q.stream)), h('span', {}, String(q.n))))) : null);
  return h('div', {},
    h('div', { class: 'side-block' }, part('blocked', secHead('Blocked', st.blocked.length), st.blocked.length ? itemRows(st.blocked, ctx) : empty('Nothing is blocked.', 'a tempo'))),
    h('div', { class: 'side-block' }, part('flight', secHead('In flight', st.working.length), flight)));
}

// ---- Shipped today, and the two gauges ----

const CI_LABEL: Record<CiKey, string> = { pass: 'Passing', pending: 'Pending', fail: 'Failing', none: 'No checks' };

export function deckSection(st: PodiumState, charts: ChartsData | null, redraw: () => void): HTMLElement {
  const newest = [...st.done].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const items = newest.map((d, i) => h('li', { hidden: !homeUi.allShipped && i >= SHIPPED_CAP },
    h('span', { class: 'shipped-text' }, d.text, d.ticket ? ' ' : null, d.ticket ? refLink(d.ticket) : null),
    h('span', { class: 'shipped-meta' }, streamTag(d.stream), h('span', {}, clockTime(d.closedAt, st.tz)))));
  const more = newest.length > SHIPPED_CAP
    ? (() => {
      const b = h('button', { type: 'button', class: 'more', 'data-ctl': 'more-shipped', 'aria-expanded': String(homeUi.allShipped) }, homeUi.allShipped ? 'Show fewer' : `Show all ${newest.length}`, h('span', { class: 'vh' }, ' shipped items'), h('span', { class: 'chev', 'aria-hidden': 'true' }));
      b.addEventListener('click', () => { homeUi.allShipped = !homeUi.allShipped; redraw(); });
      return h('div', { class: 'more-row' }, b);
    })()
    : null;
  return h('div', { class: 'deck' },
    part('shipped', secHead('Shipped today', newest.length, 'Newest first'), items.length ? h('ul', { class: 'shipped', role: 'list' }, ...items) : empty('Nothing shipped yet today.', 'before the downbeat'), more),
    gauges(st, charts));
}

function gauges(st: PodiumState, charts: ChartsData | null): HTMLElement {
  const bars = askAgeBars(st.asks);
  const top = Math.max(1, ...bars.map((b) => b.n));
  const g = prGauge(st.prs, charts);
  const keys: CiKey[] = ['pass', 'pending', 'fail', 'none'];
  const over = g.queue !== null && g.queue.count > g.queue.cap;
  const fact = (n: number, text: string, warn = false): HTMLElement => h('div', { class: warn ? 'warn' : undefined }, h('b', {}, String(n)), text);
  return h('div', { class: 'gauges' },
    h('section', { class: 'gauge', 'aria-labelledby': 'g-age' },
      h('h3', { id: 'g-age' }, 'Open asks by age'), h('p', { class: 'cap' }, 'Past 3 days is stale, shown in amber.'),
      h('ul', { class: 'bars', role: 'list' }, ...bars.map((b) => h('li', { class: b.stale ? 'stale' : undefined },
        h('span', {}, b.label), h('span', { class: 'track', 'aria-hidden': 'true' }, fill(b.n / top)), h('span', { class: 'v' }, String(b.n)))))),
    h('section', { class: 'gauge', 'aria-labelledby': 'g-pr' },
      h('h3', { id: 'g-pr' }, 'Open PRs ', h('span', { class: 'n' }, `· ${g.total}`)),
      h('p', { class: 'cap' }, 'CI state across every stream. ', h('a', { href: formatFragment(OPEN_PRS) }, 'Open the PR board')),
      h('div', { class: 'cibar', 'aria-hidden': 'true' }, ...keys.filter((k) => g.ci[k] > 0).map((k) => grow(`ci-${k}`, g.ci[k]))),
      h('ul', { class: 'legend', role: 'list' }, ...keys.map((k) => h('li', {}, h('i', { class: `ci-${k}`, 'aria-hidden': 'true' }), `${CI_LABEL[k]} ${g.ci[k]}`))),
      h('div', { class: 'facts3' },
        g.queue ? fact(g.queue.count, ` in your review queue, cap ${g.queue.cap}`, over) : null,
        fact(g.threads, ' with open threads'), fact(g.conflicting, ' conflicting'))));
}

// ---- Epics and project notes ----

export function epicsSection(e: EpicsData | null, links: HomeLink[]): HTMLElement | null {
  const cards = epicCards(e);
  const notes = links.flatMap((l) => { const a = linkAttrs(l.url); return a ? [h('li', {}, h('a', { ...a, title: `${l.stream}, ${LINK_KIND[l.kind]}` }, l.label))] : []; });
  if (cards.length === 0 && notes.length === 0) return null;
  return part('epic-part', secHead('Epics', cards.length, 'Tickets closed, in progress, blocked and not started'),
    cards.length ? h('ul', { class: 'ecards', role: 'list' }, ...cards.map(epicCard)) : empty('No open epics.'),
    notes.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Project notes' }, h('li', {}, 'Project notes'), ...notes) : null);
}

function epicCard(c: EpicCard): HTMLElement {
  const { line } = c;
  return h('li', {}, h('article', { class: 'ecard' },
    h('div', { class: 'ecard-top' }, h('span', { class: 'nm' }, h('i', { class: `mark-sq ${seriesClass(c.stream)}`, 'aria-hidden': 'true' }), c.stream), h('span', { class: 'id' }, line.id)),
    h('p', { class: 'ecard-title' }, refLink({ label: line.title, url: line.note.url })),
    h('p', { class: 'ecard-n' }, h('b', {}, String(line.closed)), `of ${line.total} closed`, line.blocked > 0 ? h('span', { class: 'bl' }, `${line.blocked} blocked`) : null),
    h('div', { class: 'seg-bar', 'aria-hidden': 'true' }, ...c.segments.filter((s) => s.n > 0).map((s) => grow(`sg-${s.key}`, s.n))),
    line.next ? h('p', { class: 'ecard-next' }, 'Next ', refLink({ label: line.next.id, url: line.next.ref.url }), ' ', line.next.title) : null));
}

/** One stream's last 14 days as a large staff with each day's count under it, for the stream tab. Null when there is no score to draw. */
export function streamScore(st: PodiumState, charts: ChartsData | null, stream: string): HTMLElement | null {
  if (!charts || charts.days.length === 0) return null;
  const score = scoreTable(st, charts, null);
  const row = score.rows.find((r) => r.stream === stream);
  if (!row) return null;
  const cls = seriesClass(stream);
  const labels = h('span', { class: 'daycols', 'aria-hidden': 'true' }, ...score.days.map((d) => h('span', { class: d.today ? 'today' : undefined }, d.today ? 'Today' : d.label)));
  const cells = score.days.map((d, i) => h('span', { class: `score-cell${d.weekStart ? ' wk' : ''}${d.today ? ' today' : ''}` },
    row.pitches[i] ? h('span', { class: `score-note p${row.pitches[i]} ${cls}` }) : h('span', { class: 'score-rest' })));
  return part('big-staff', secHead('Last 14 days', row.total, 'Tasks finished per day. Higher notes mean more.'),
    labels,
    h('div', { class: 'score-staff', role: 'img', 'aria-label': `${stream}, tasks finished per day: ${score.days.map((d, i) => `${d.date} ${row.days[i]}`).join(', ')}` }, ...cells),
    h('div', { class: 'tally', 'aria-hidden': 'true' }, ...row.days.map((n) => h('span', {}, String(n)))));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** The right-hand panel of a stream tab: where today's priorities put this stream (or that none does), and its notes. Home shows only the stream; the priority's text is here, and the stream's epics are in Where it stands below. */
export function todayPanel(priorities: { text: string; stream?: string }[], projects: ProjectsData | null, stream: string): HTMLElement {
  const ranked = priorities.flatMap((p, i) => { const s = splitStream(p); return s.stream === stream ? [{ rank: i + 1, text: s.text }] : []; });
  const li = (l: HomeLink): HTMLElement[] => { const a = linkAttrs(l.url); return a ? [h('li', {}, h('a', { ...a, title: LINK_KIND[l.kind] }, l.label))] : []; };
  const mine = (projects?.links ?? []).filter((l) => l.stream === stream);
  const notes = mine.filter((l) => l.kind !== 'library').flatMap(li);
  const library = mine.filter((l) => l.kind === 'library').flatMap(li);
  return h('section', { class: 'today-panel', 'aria-labelledby': 'today-h' },
    h('h2', { id: 'today-h' }, 'Today'),
    ...(ranked.length
      ? ranked.map((m) => h('p', {}, h('span', { class: 'rk' }, `Priority ${ROMAN[m.rank - 1] ?? m.rank} · `), m.text))
      : [h('p', {}, 'Not in today\'s priorities. ', h('i', { lang: 'la' }, 'tacet'))]),
    notes.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Notes' }, ...notes) : null,
    // Shown once the projects payload has loaded, so a stream is never called empty while the answer is still on its way.
    projects ? (library.length ? h('ul', { class: 'notes-row', role: 'list', 'aria-label': 'Library' }, h('li', {}, 'Library'), ...library) : h('p', { class: 'library-none' }, 'No library yet.')) : null);
}
