/** Paging for the Others' PRs list. Pure and DOM-free, so node:test covers it. */
import { pageView } from './page-math.ts';
import type { PageView } from './page-math.ts';

/** Rows on one page of an Others' PRs sub-tab (not counting the rows that need you). */
export const PAGE_SIZE = 25;

export interface PagePlan<T> {
  /** What to draw, in order: the pinned rows, then the current page of the rest, each in its own order. */
  shown: T[];
  /** Every row there is, and where the current page falls among the unpinned rows. */
  total: number; view: PageView;
}

/**
 * Pinned rows (a waiting draft, a review asked of you) lead and are never paged away; the others show `PAGE_SIZE` to a page.
 * `page` is 1-based and clamped into range. Order within each group is the order given.
 */
export function pagePlan<T>(rows: readonly T[], isPinned: (row: T) => boolean, page: number): PagePlan<T> {
  const pinned = rows.filter(isPinned);
  const rest = rows.filter((r) => !isPinned(r));
  const view = pageView(rest.length, page, PAGE_SIZE);
  return { shown: [...pinned, ...rest.slice(view.from === 0 ? 0 : view.from - 1, view.to)], total: rows.length, view };
}
