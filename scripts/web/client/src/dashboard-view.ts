/** The Dashboard tab: four read-only quadrants, each a small chart, a linked list and a table view. Draws what dashboard-model works out. */
import { h, s } from './dom.ts';
import { linkAttrs } from './link-policy.ts';
import { LIST_ROWS, ASKS_HREF, WORKING_HREF, doneOn, donePerDay, inFlight, needsYou, prsWaiting, streamColors } from './dashboard-model.ts';
import type { DoneDay, Row } from './dashboard-model.ts';
import { formatFragment } from './tabs.ts';
import type { ChartsData, PodiumState } from './types.ts';

export interface DashboardOptions { day: string | null; setDay: (day: string | null) => void }

const W = 336;          // chart viewBox width: 14 day columns of 24
const H = 160;          // chart height from the design note
const UNIT = 24;        // the smallest mark a pointer or finger can hit
let seq = 0;

export function dashboardView(st: PodiumState, charts: ChartsData | null, opts: DashboardOptions): HTMLElement {
  return h('div', { class: 'dash' },
    h('div', { class: 'dash-grid' }, needsQuadrant(st, charts), prQuadrant(st, charts), flightQuadrant(st), doneQuadrant(st, charts, opts)));
}

// ---- the four quadrants ----

function needsQuadrant(st: PodiumState, charts: ChartsData | null): HTMLElement {
  const m = needsYou(st, charts);
  if (m.n === 0) return quadrant('Needs you', 0, null, emptyText('Nothing needs you. The next ask will appear here with its recommendation.'));
  const max = Math.max(1, ...(m.buckets ?? []).map((b) => b.count));
  const slot = W / Math.max(1, m.buckets?.length ?? 1);
  const chart = m.buckets ? svgChart('Open asks by age', 'Count of open asks in each age bucket. Each bar opens the asks on the Board.',
    m.buckets.map((b, i) => {
      const bar = Math.round((b.count / max) * (H - 48));
      return mark({ href: ASKS_HREF }, `${b.count} open ${b.count === 1 ? 'ask' : 'asks'}, ${b.label}. Open on the Board.`, `ask-age-${i}`,
        s('rect', { class: 'hit', x: String(i * slot), y: '0', width: String(slot), height: String(H - 20) }),
        b.count > 0 ? s('path', { class: 'bar accent', d: bar > 0 ? columnPath(i * slot + slot / 2 - 12, H - 20 - bar, 24, bar) : '' }) : null,
        s('text', { class: 'val', x: String(i * slot + slot / 2), y: String(H - 24 - bar), 'text-anchor': 'middle' }, String(b.count)),
        s('text', { class: 'lab', x: String(i * slot + slot / 2), y: String(H - 4), 'text-anchor': 'middle' }, b.label));
    })) : missingCharts();
  const table = m.buckets ? tableView('Open asks by age', ['Age', 'Asks'], m.buckets.map((b) => [b.label, String(b.count)])) : null;
  return quadrant('Needs you', m.n, null, chart, rowList(m.rows, `All ${m.n} on the Board`, ASKS_HREF), table);
}

function prQuadrant(st: PodiumState, charts: ChartsData | null): HTMLElement {
  const m = prsWaiting(st, charts);
  const note = m.stale ? h('p', { class: 'warn' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), m.stale) : null;
  if (!m.columns) return quadrant('PRs waiting', 0, note, missingCharts());
  if (m.n === 0) {
    return quadrant('PRs waiting', 0, note, emptyText(st.prData.fetchedAt ? 'No open pull requests in the snapshot.' : 'PR data is missing: the PR snapshot has never been fetched.'));
  }
  const tallest = Math.max(1, ...m.columns.map((c) => c.inQueue.length + c.other.length));
  const unit = Math.max(8, Math.min(20, Math.floor((H - 40) / tallest) - 2));
  const slot = W / m.columns.length;
  const chart = svgChart('Open pull requests by age', 'One square per pull request, stacked by age. Filled squares are in the review queue, outlined squares are not. Dashed squares, in the last column, have no creation date. Each square opens the pull request.',
    m.columns.map((c, i) => {
      const cx = i * slot + slot / 2;
      const squares = [...c.inQueue.map((p) => ({ p, inQ: true })), ...c.other.map((p) => ({ p, inQ: false }))].map(({ p, inQ }, k) => {
        const y = H - 20 - (k + 1) * (unit + 2);
        const attrs = linkAttrs(p.url);
        const age = c.undated ? 'no creation date' : c.label;
        return mark(attrs ?? { href: formatFragment('overview') }, `${p.title}, ${p.repo} number ${p.number}, ${age}, ${inQ ? 'in the review queue' : 'not in the review queue'}`, `pr-${p.repo}-${p.number}`,
          s('rect', { class: `unit ${inQ ? 'fill' : 'ring'}${c.undated ? ' undated' : ''}`, x: String(cx - unit / 2), y: String(y), width: String(unit), height: String(unit), rx: '3' }),
          s('rect', { class: 'hit', x: String(cx - Math.max(unit, UNIT) / 2), y: String(y - 1), width: String(Math.max(unit, UNIT)), height: String(unit + 2) }));
      });
      return s('g', {}, ...squares, s('text', { class: 'lab', x: String(cx), y: String(H - 4), 'text-anchor': 'middle' }, c.label));
    }));
  const cap = m.queue && 'cap' in m.queue ? ` (counts toward cap ${m.queue.cap}; ${m.queue.count} counted now)` : '';
  const legend = h('p', { class: 'legend' },
    h('span', { class: 'key' }, h('i', { class: 'sw fill', 'aria-hidden': 'true' }), `in the review queue${cap}`), ' ',
    h('span', { class: 'key' }, h('i', { class: 'sw ring', 'aria-hidden': 'true' }), 'other open (self-review repos)'),
    m.columns.some((c) => c.undated) ? h('span', { class: 'key' }, h('i', { class: 'sw undated', 'aria-hidden': 'true' }), 'no creation date') : null,
    m.drafts > 0 ? h('span', { class: 'key' }, `${m.drafts} ${m.drafts === 1 ? 'draft is' : 'drafts are'} not counted`) : null);
  const table = tableView('Open pull requests by age', ['Age', 'In the review queue', 'Other open'], m.columns.map((c) => [c.label, String(c.inQueue.length), String(c.other.length)]));
  return quadrant('PRs waiting', m.n, note, chart, legend, rowList(m.rows, '', null), table);
}

function flightQuadrant(st: PodiumState): HTMLElement {
  const m = inFlight(st);
  if (m.n === 0) return quadrant('In flight', 0, null, emptyText('Nothing in flight. Work that is running will appear here, by stream.'));
  const colour = streamColors(st.streams);
  const rowH = 32;
  const labelW = 112;
  const max = Math.max(1, ...m.bars.map((b) => b.count));
  const height = m.bars.length * rowH + 4;
  const chart = svgChart('In flight by stream', 'Count of items in flight in each stream. Each bar opens the stream.', m.bars.map((b, i) => {
    const w = Math.max(4, Math.round((b.count / max) * (W - labelW - 40)));
    return mark({ href: b.tab }, `${b.stream}: ${b.count} in flight. Open the ${b.stream} tab.`, `flight-${i}`,
      s('rect', { class: 'hit', x: '0', y: String(i * rowH), width: String(W), height: String(rowH) }),
      s('text', { class: 'lab', x: '0', y: String(i * rowH + 20) }, b.stream.length > 16 ? `${b.stream.slice(0, 15)}…` : b.stream),
      s('rect', { class: `bar ${colour(b.stream)}`, x: String(labelW), y: String(i * rowH + 6), width: String(w), height: '20', rx: '4' }),
      s('text', { class: 'val', x: String(labelW + w + 6), y: String(i * rowH + 21) }, String(b.count)));
  }), height);
  const table = tableView('In flight by stream', ['Stream', 'In flight'], m.bars.map((b) => [b.stream, String(b.count)]));
  return quadrant('In flight', m.n, null, chart, rowList(m.rows, `All ${m.n} on the Board`, WORKING_HREF), table);
}

function doneQuadrant(st: PodiumState, charts: ChartsData | null, opts: DashboardOptions): HTMLElement {
  const m = donePerDay(st, charts);
  if (!m || !charts) return quadrant('Done, 14 days', 0, null, missingCharts());
  if (m.total === 0) return quadrant('Done, 14 days', 0, null, emptyText('Nothing finished in the last 14 days. Items you close will count here, by day.'));
  const colour = streamColors(st.streams);
  const max = Math.max(1, ...m.days.map((d) => d.total));
  const slot = W / m.days.length;
  const top = 16;
  const scale = (H - 20 - top) / max;
  const chart = svgChart('Done per day, by stream', 'Count of items finished each day over fourteen days, stacked by stream. Each column opens that day\'s items below.',
    m.days.map((d, i) => {
      const x = i * slot + (slot - 16) / 2;
      let y = H - 20;
      const segs = m.streams.filter((name) => (d.byStream[name] ?? 0) > 0).map((name) => {
        const hgt = Math.max(2, (d.byStream[name] ?? 0) * scale - 2);
        y -= hgt + 2;
        return s('rect', { class: `seg ${colour(name)}`, x: String(x), y: String(y), width: '16', height: String(hgt), rx: '2' });
      });
      const last = i === m.days.length - 1;
      const open = opts.day === d.date;
      const node = s('a', { href: formatFragment('dashboard'), id: `done-${d.date}`, 'aria-label': `${d.date}: ${d.total} done. ${open ? 'Hide' : 'Show'} the items.`, class: `mark${open ? ' open' : ''}`, 'aria-expanded': String(open) },
        s('title', {}, `${d.date}: ${d.total} done`),
        s('rect', { class: 'hit', x: String(i * slot), y: '0', width: String(slot), height: String(H - 20) }),
        ...segs,
        last || open ? s('text', { class: 'val', x: String(x + 8), y: String(y - 4), 'text-anchor': 'middle' }, String(d.total)) : null,
        i === 0 || last ? s('text', { class: 'lab', x: String(x + 8), y: String(H - 4), 'text-anchor': i === 0 ? 'start' : 'end' }, d.date.slice(5)) : null);
      node.addEventListener('click', (e) => { e.preventDefault(); opts.setDay(open ? null : d.date); });
      return node;
    }));
  const legend = m.streams.length > 1 ? h('p', { class: 'legend' }, ...m.streams.map((name) => h('span', { class: 'key' },
    h('i', { class: `sw ${colour(name)}`, 'aria-hidden': 'true' }), name))) : null;
  const day = opts.day ? m.days.find((d) => d.date === opts.day) : undefined;
  const table = tableView('Done per day, by stream', ['Day', ...m.streams, 'Total'], m.days.map((d) => [d.date, ...m.streams.map((n) => String(d.byStream[n] ?? 0)), String(d.total)]));
  return quadrant('Done, 14 days', m.total, null, chart, legend, day ? dayList(day, charts) : null, table);
}

// ---- pieces ----

function dayList(day: DoneDay, charts: ChartsData): HTMLElement {
  const { rows, missing } = doneOn(day, charts.doneItems);
  return h('div', { class: 'day' },
    h('h3', {}, `Finished ${day.date}`, h('span', { class: 'count' }, ` ${day.total}`)),
    rows.length > 0 ? rowList(rows, '', null, rows.length) : null,
    missing > 0 ? h('p', { class: 'note' }, `${missing} older ${missing === 1 ? 'item is' : 'items are'} past the newest ${charts.doneItems.length} the page holds.`) : null);
}

function quadrant(title: string, n: number, note: Node | null, ...body: (Node | null)[]): HTMLElement {
  const id = `q${++seq}`;
  return h('section', { class: 'quad', 'aria-labelledby': id },
    h('div', { class: 'head' }, h('h2', { id }, title, n > 0 ? h('span', { class: 'count' }, h('span', { class: 'vh' }, ', '), String(n)) : null)),
    note, ...body);
}

const emptyText = (text: string): HTMLElement => h('p', { class: 'empty' }, text);
const missingCharts = (): HTMLElement => emptyText('Chart data is missing. The server did not send /api/charts, so nothing is drawn here.');

function svgChart(title: string, desc: string, marks: (Node | null)[], height = H, baseline = true): SVGSVGElement {
  const t = `t${++seq}`;
  const d = `d${seq}`;
  return s('svg', { class: 'chart', viewBox: `0 0 ${W} ${height}`, role: 'group', 'aria-labelledby': `${t} ${d}`, focusable: 'false' },
    s('title', { id: t }, title), s('desc', { id: d }, desc),
    baseline ? s('line', { class: 'base', x1: '0', x2: String(W), y1: String(height - 20), y2: String(height - 20) }) : null,
    ...marks);
}

/** One focusable, labelled link mark. `link` carries href, and target and rel for a link that leaves the page. */
function mark(link: Record<string, string | boolean | undefined>, label: string, id: string, ...parts: (Node | null)[]): SVGAElement {
  return s('a', { ...link, class: 'mark', id: `m-${id.replace(/[^\w-]/g, '_')}`, 'aria-label': label }, s('title', {}, label), ...parts);
}

/** A column with its top corners rounded and a square base. */
function columnPath(x: number, y: number, w: number, hgt: number): string {
  const r = Math.min(4, w / 2, hgt);
  return `M${x} ${y + hgt}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + hgt}Z`;
}

/** Up to LIST_ROWS rows as full-width links, then a link to the rest when there is somewhere to send the reader. */
function rowList(rows: Row[], all: string, allHref: string | null, limit = LIST_ROWS): HTMLElement | null {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, limit);
  const more = rows.length - shown.length;
  return h('div', { class: 'list' },
    h('ul', { class: 'dash-rows', role: 'list' }, ...shown.map((r) => {
      const ext = r.url ? linkAttrs(r.url) : undefined;
      const external = ext?.target === '_blank';
      return h('li', {}, h('a', { class: 'row', ...(ext ?? { href: r.tab }) },
        h('span', { class: 'rt' }, r.text), h('span', { class: 'rm' }, r.meta),
        h('span', { class: 'go', 'aria-hidden': 'true' }, external ? '↗' : '›'),
        external ? h('span', { class: 'vh' }, ' (opens in a new tab)') : null));
    })),
    more > 0 ? (allHref && all ? h('a', { class: 'all', href: allHref }, all) : h('p', { class: 'note' }, `${more} more in the table view.`)) : null);
}

function tableView(title: string, head: string[], body: string[][]): HTMLElement {
  // Named, so a live redraw keeps the table open for a reader who opened it (see keep-view).
  return h('details', { class: 'tv', 'data-fold': `dash-${title.toLowerCase().replace(/[^a-z]+/g, '-')}` }, h('summary', {}, 'Table view'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'counts' }, h('caption', { class: 'vh' }, title),
      h('thead', {}, h('tr', {}, ...head.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...body.map((r) => h('tr', {}, ...r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', {}, c)))))))));
}

export const DASHBOARD_CSS = `
  .dash-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-7) var(--space-7); }
  @media (min-width: 900px) { .dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .quad { min-width: 0; }
  .quad .head { margin-bottom: var(--space-3); }
  .quad .warn { margin: 0 0 var(--space-3); color: var(--warning); font-size: var(--text-sm); line-height: var(--leading-sm); }
  .chart { display: block; width: 100%; height: auto; max-height: 200px; margin-bottom: var(--space-2); font-variant-numeric: tabular-nums; overflow: visible; }
  .chart .base { stroke: var(--grid-line); stroke-width: 1; }
  .chart .hit { fill: transparent; }
  .chart .bar.accent { fill: var(--accent); }
  .c-1 { fill: var(--series-1); } .c-2 { fill: var(--series-2); } .c-3 { fill: var(--series-3); } .c-4 { fill: var(--series-4); }
  .c-5 { fill: var(--series-5); } .c-6 { fill: var(--series-6); } .c-7 { fill: var(--series-7); } .c-8 { fill: var(--series-8); } .c-other { fill: var(--series-other); }
  .chart .unit.fill { fill: var(--series-1); }
  .chart .unit.ring { fill: none; stroke: var(--series-1); stroke-width: 2; }
  .chart .unit.undated { stroke: var(--text-primary); stroke-width: 2; stroke-dasharray: 3 2; }
  .chart .unit.undated.ring { fill: none; }
  .chart .lab { fill: var(--text-muted); font-size: var(--text-xs); }
  .chart .val { fill: var(--text-primary); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .chart a.mark { cursor: pointer; }
  .chart a.mark:focus-visible { outline: none; }
  .chart a.mark:focus-visible .hit, .chart a.mark.open .hit { stroke: var(--focus); stroke-width: 2; rx: 4; }
  @media (hover: hover) { .chart a.mark:hover .hit { fill: var(--accent-soft); } }
  .legend { margin: 0 0 var(--space-3); display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-secondary); }
  .legend .key { display: inline-flex; align-items: center; gap: var(--space-2); }
  .legend .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; }
  .legend .sw.fill { background: var(--series-1); }
  .legend .sw.ring { background: none; border: 2px solid var(--series-1); }
  .legend .sw.undated { background: none; border: 2px dashed var(--text-primary); }
  .legend .sw.c-1 { background: var(--series-1); } .legend .sw.c-2 { background: var(--series-2); } .legend .sw.c-3 { background: var(--series-3); } .legend .sw.c-4 { background: var(--series-4); }
  .legend .sw.c-5 { background: var(--series-5); } .legend .sw.c-6 { background: var(--series-6); } .legend .sw.c-7 { background: var(--series-7); } .legend .sw.c-8 { background: var(--series-8); } .legend .sw.c-other { background: var(--series-other); }
  ul.dash-rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  ul.dash-rows > li { border-bottom: 1px solid var(--border); }
  a.row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--space-1) var(--space-3); align-items: baseline; min-height: 44px; padding: var(--space-2) var(--space-1); color: var(--text-primary); text-decoration: none; font-size: var(--text-md); line-height: var(--leading-md); }
  a.row .rt { min-width: 0; overflow-wrap: anywhere; }
  a.row .rm { color: var(--text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  a.row .go { color: var(--text-muted); }
  @media (hover: hover) { a.row:hover { background: var(--accent-soft); } }
  @media (max-width: 480px) { a.row { grid-template-columns: minmax(0, 1fr) auto; } a.row .rm { grid-column: 1; grid-row: 2; } a.row .go { grid-column: 2; grid-row: 1 / span 2; align-self: center; } }
  a.all { display: inline-flex; align-items: center; min-height: 44px; font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .quad .note, .day .note { margin: var(--space-2) 0 0; color: var(--text-muted); font-size: var(--text-sm); }
  .day { margin-top: var(--space-3); }
  .day h3 { margin: 0 0 var(--space-2); font-size: var(--text-md); line-height: var(--leading-md); font-weight: var(--weight-semibold); }
  .day h3 .count { font-weight: var(--weight-regular); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  details.tv { margin-top: var(--space-3); }
  details.tv > summary { cursor: pointer; min-height: 32px; font-size: var(--text-sm); color: var(--text-secondary); }
  @media (prefers-reduced-motion: no-preference) { .chart .bar, .chart .seg { transition: height var(--dur-base) var(--ease-out); } }
`;
