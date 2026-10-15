/** The board when a summary tile is pressed: only that tile's items, drawn from the same buckets the tile counts. */
import { h } from './dom.ts';
import { seriesClass } from './series.ts';
import { needsRows } from './needs-view.ts';
import { withComments } from './blocked-rows.ts';
import type { NeedsItem } from './needs-items.ts';
import { RESTS, askCards, askHint, itemRows, section } from './stream-board.ts';
import type { RowContext, SectionSpec } from './stream-board.ts';
import type { Buckets } from './glance.ts';
import { CLEAR_FILTER_ID } from './tabs.ts';
import type { CueKey } from './tabs.ts';

/** How each tile's section reads: the same titles, glyphs and empty sentences the unfiltered board uses. */
export const FILTER_SECTIONS: Record<CueKey, Omit<SectionSpec, 'n'>> = {
  asks: { title: 'Needs you', glyph: '●', tone: 'accent', empty: 'Nothing needs you right now.', rest: RESTS.asks },
  blocked: { title: 'Blocked', glyph: '⊘', tone: 'critical', empty: 'Nothing is blocked.', rest: RESTS.blocked },
  done: { title: 'Shipped today', glyph: '✓', tone: 'success', empty: 'Nothing shipped yet today.', rest: RESTS.shipped },
  working: { title: 'In flight', tone: 'neutral', empty: 'Nothing in flight.', rest: RESTS.working },
};

/** What the filtered view needs beyond the buckets: whether answers can be sent, the row context, and how to clear the filter. */
/** `extra` are the PRs ready to merge and the reviews waiting for an OK; they join the asks view only, and the stream chips count and filter them with the asks. */
export interface FilterOptions { live: boolean; ctx: RowContext; clear: () => void; extra?: NeedsItem[]; stream?: string | null; setStream?: (stream: string | null) => void }

/** One stream chip: the stream (null for All) and how many asks it holds. */
export interface StreamChip { stream: string | null; n: number }

/** All, then each stream that has open asks, busiest first and then by name. Fewer than two streams means nothing to narrow, so no chips. */
export function streamChips(asks: { stream: string }[]): StreamChip[] {
  const counts = new Map<string, number>();
  for (const a of asks) counts.set(a.stream, (counts.get(a.stream) ?? 0) + 1);
  if (counts.size < 2) return [];
  const rest = [...counts].map(([stream, n]) => ({ stream, n })).sort((a, b) => (b.n - a.n) || a.stream.localeCompare(b.stream));
  return [{ stream: null, n: asks.length }, ...rest];
}

/** The picked stream if it still has asks, otherwise null (All): a stale link or a stream that was just answered away falls back quietly. */
export function activeStream(asks: { stream: string }[], picked: string | null | undefined): string | null {
  return picked && asks.some((a) => a.stream === picked) ? picked : null;
}

/** A chip's DOM id: stable so a live redraw refocuses it (keep-view's focusKeyOf), and distinct for a stream literally named "all". */
export function chipId(stream: string | null): string { return stream === null ? 'stream-chip-all' : `stream-chip:${encodeURIComponent(stream)}`; }

function chipRow(chips: StreamChip[], picked: string | null, set: (stream: string | null) => void): HTMLElement {
  const items = chips.map(({ stream, n }) => {
    const b = h('button', { type: 'button', class: 'fchip', id: chipId(stream), 'data-ctl': chipId(stream), 'aria-pressed': String(picked === stream) },
      stream ? h('i', { class: seriesClass(stream), 'aria-hidden': 'true' }) : null, stream ?? 'All', ' ', h('span', { class: 'c' }, String(n)));
    b.addEventListener('click', () => set(stream));
    return h('li', {}, b);
  });
  return h('ul', { class: 'chips-row', role: 'list', 'aria-label': 'Filter what needs you by stream' }, ...items);
}

/** The ask list and the item rows as one body, kept as siblings so the section's list styling still applies to each. Null when both are empty. */
function asksAndItems(asks: Node | null, items: Node | null): Node | null {
  if (!asks || !items) return asks ?? items;
  const both = document.createDocumentFragment();
  both.append(asks, items);
  return both;
}

/** Every item in one bucket, uncapped, under its own heading, with a way back to the whole board. */
export function filteredView(buckets: Buckets, key: CueKey, label: string, o: FilterOptions): Node {
  const spec = FILTER_SECTIONS[key];
  const extra = key === 'asks' ? o.extra ?? [] : [];
  const everything = key === 'asks' ? [...buckets.asks, ...extra] : [];
  const picked = key === 'asks' ? activeStream(everything, o.stream) : null;
  const items = key === 'asks' && picked ? buckets.asks.filter((a) => a.stream === picked) : buckets[key];
  const shownExtra = picked ? extra.filter((x) => x.stream === picked) : extra;
  const chips = key === 'asks' && o.setStream ? streamChips(everything) : [];
  const body = key === 'asks'
    ? asksAndItems(askCards(items as Buckets['asks'], o.live, o.ctx.showStream)?.list ?? null, needsRows(shownExtra, o.ctx.showStream))
    : key === 'blocked' ? withComments(itemRows(buckets.blocked, o.ctx), buckets.blocked, o.live)
    : itemRows(items as Parameters<typeof itemRows>[0], o.ctx);
  const clear = h('button', { type: 'button', class: 'more', id: CLEAR_FILTER_ID }, 'Show everything');
  clear.addEventListener('click', o.clear);
  // The bar is always there, so an empty result still has its way back; the section below carries the count and the empty sentence.
  return h('div', { class: 'filtered' },
    h('p', { class: 'filter-bar' }, `Showing only ${label}.`, ' ', clear),
    chips.length && o.setStream ? chipRow(chips, picked, o.setStream) : null,
    section({ ...spec, n: items.length + shownExtra.length, hint: key === 'asks' && items.length > 0 ? askHint(o.live) : null }, body));
}
