/** The board when a summary tile is pressed: only that tile's items, drawn from the same buckets the tile counts. */
import { h } from './dom.ts';
import { RESTS, askCards, askHint, itemRows, section } from './stream-board.ts';
import type { RowContext, SectionSpec } from './stream-board.ts';
import type { Buckets } from './glance.ts';
import type { CueKey } from './tabs.ts';

/** How each tile's section reads: the same titles, glyphs and empty sentences the unfiltered board uses. */
export const FILTER_SECTIONS: Record<CueKey, Omit<SectionSpec, 'n'>> = {
  asks: { title: 'Needs you', glyph: '●', tone: 'accent', empty: 'Nothing needs you right now.', rest: RESTS.asks },
  blocked: { title: 'Blocked', glyph: '⊘', tone: 'critical', empty: 'Nothing is blocked.', rest: RESTS.blocked },
  done: { title: 'Shipped today', glyph: '✓', tone: 'success', empty: 'Nothing shipped yet today.', rest: RESTS.shipped },
  working: { title: 'In flight', tone: 'neutral', empty: 'Nothing in flight.', rest: RESTS.working },
};

/** What the filtered view needs beyond the buckets: whether answers can be sent, the row context, and how to clear the filter. */
export interface FilterOptions { live: boolean; ctx: RowContext; clear: () => void }

/** Every item in one bucket, uncapped, under its own heading, with a way back to the whole board. */
export function filteredView(buckets: Buckets, key: CueKey, label: string, o: FilterOptions): Node {
  const spec = FILTER_SECTIONS[key];
  const items = buckets[key];
  const body = key === 'asks'
    ? askCards(buckets.asks, o.live, o.ctx.showStream)?.list ?? null
    : itemRows(items as Parameters<typeof itemRows>[0], o.ctx);
  const clear = h('button', { type: 'button', class: 'more' }, 'Show everything');
  clear.addEventListener('click', o.clear);
  // The bar is always there, so an empty result still has its way back; the section below carries the count and the empty sentence.
  return h('div', { class: 'filtered' },
    h('p', { class: 'filter-bar' }, `Showing only ${label}.`, ' ', clear),
    section({ ...spec, n: items.length, hint: key === 'asks' && items.length > 0 ? askHint(o.live) : null }, body));
}
