/**
 * One pager for every list the Podium used to cut off with "Show all": a page size per list, "Page N of M", Previous and Next.
 * Page numbers live in `PAGES`, keyed by list, so a live refresh that redraws a list lands on the same page.
 * The buttons stay focusable at either end (aria-disabled, not disabled), so pressing Next on the last-but-one page does not drop keyboard focus.
 */
import { h } from './dom.ts';
import { pageView } from './page-math.ts';
import type { PageView } from './page-math.ts';

export { pageView };
export type { PageView };

/** The page each list is on, by key. A list whose rows shrink is clamped when it next draws. */
export const PAGES = new Map<string, number>();

export interface PagerOptions { label: string; key: string; go: (page: number, dir: 'prev' | 'next') => void }
export interface Pager { el: HTMLElement; update: (v: PageView) => void }

/**
 * The Previous / "Page N of M" / Next control, or null when everything fits on one page. `label` names the list for screen readers ("Cues").
 * `update` changes the page numbers and the disabled state in place, so a list that does not redraw keeps keyboard focus on the pressed button.
 */
export function pager(v: PageView, o: PagerOptions): Pager | null {
  if (v.pages <= 1) return null;
  let cur = v;
  const button = (dir: 'prev' | 'next'): HTMLElement => {
    const b = h('button', { type: 'button', class: 'pg', 'data-dir': dir, 'aria-label': `${dir === 'prev' ? 'Previous' : 'Next'} page of ${o.label}` },
      dir === 'prev' ? h('span', { 'aria-hidden': 'true' }, '\u2039 ') : null, dir === 'prev' ? 'Previous' : 'Next', dir === 'next' ? h('span', { 'aria-hidden': 'true' }, ' \u203a') : null);
    b.addEventListener('click', () => { if (b.getAttribute('aria-disabled') !== 'true') o.go(cur.page + (dir === 'prev' ? -1 : 1), dir); });
    return b;
  };
  const prev = button('prev');
  const next = button('next');
  const num = h('strong', {}, '');
  const of = document.createTextNode('');
  const range = h('span', { class: 'pg-range' }, '');
  const status = h('span', { class: 'pg-status', role: 'status' }, 'Page ', num, of, range);
  const update = (to: PageView): void => {
    cur = to;
    prev.setAttribute('aria-disabled', String(to.page <= 1));
    next.setAttribute('aria-disabled', String(to.page >= to.pages));
    num.textContent = String(to.page);
    of.textContent = ` of ${to.pages}`;
    range.textContent = ` (${to.from}\u2013${to.to} of ${to.total})`;
  };
  update(v);
  return { el: h('nav', { class: 'pager', 'aria-label': `${o.label} pages`, 'data-pager': o.key }, prev, status, next), update };
}

/**
 * Pages a list of rows already in the DOM: shows one page by toggling `hidden`, and returns the pager to place after the list (null when one page suffices).
 * Nothing is redrawn, so focus stays on the button that was pressed.
 */
export function pagedRows(rows: readonly HTMLElement[], o: { key: string; size: number; label: string }): HTMLElement | null {
  const apply = (page: number): PageView => {
    const v = pageView(rows.length, page, o.size);
    PAGES.set(o.key, v.page);
    rows.forEach((r, i) => { r.hidden = i < v.from - 1 || i >= v.to; });
    return v;
  };
  const p = pager(apply(PAGES.get(o.key) ?? 1), { label: o.label, key: o.key, go: (page) => p?.update(apply(page)) });
  return p?.el ?? null;
}
