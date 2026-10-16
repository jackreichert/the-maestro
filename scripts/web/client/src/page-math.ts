/** Which rows fall on a page. Pure and DOM-free, so the node tests cover it and non-DOM modules can use it. */

export interface PageView { page: number; pages: number; size: number; total: number; from: number; to: number }

/** Where `page` (1-based, clamped into range) falls in `total` rows of `size`: how many pages, and the 1-based first and last row on it. */
export function pageView(total: number, page: number, size: number): PageView {
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  const from = total === 0 ? 0 : (at - 1) * size + 1;
  return { page: at, pages, size, total, from, to: Math.min(total, at * size) };
}
