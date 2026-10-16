/** Paging for the Others' PRs list. Pure and DOM-free, so node:test covers it. */

/** Rows added by each "Load more" press, and shown at first. */
export const PAGE_SIZE = 25;

export interface PagePlan<T> {
  /** What to draw, in order: the pinned rows, then the first `(pages + 1) * PAGE_SIZE` of the rest, each in its own order. */
  shown: T[];
  /** Every row there is, and how many are still behind the next press. */
  total: number; hidden: number;
}

/**
 * Pinned rows (a waiting draft, a review asked of you) lead and are never paged away; the others show `PAGE_SIZE` at a time.
 * `pages` is the number of "Load more" presses so far. Order within each group is the order given.
 */
export function pagePlan<T>(rows: readonly T[], isPinned: (row: T) => boolean, pages: number): PagePlan<T> {
  const pinned = rows.filter(isPinned);
  const rest = rows.filter((r) => !isPinned(r));
  const take = rest.slice(0, (Math.max(0, pages) + 1) * PAGE_SIZE);
  return { shown: [...pinned, ...take], total: rows.length, hidden: rest.length - take.length };
}
