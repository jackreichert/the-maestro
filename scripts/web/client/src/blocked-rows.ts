/** Puts a comment box on each row of the Blocked list. The rows themselves are the shared item rows (stream-board.ts `itemRows`). */
import './blocked-comment.ts';
import { h } from './dom.ts';
import type { BlockedItem } from './types.ts';

/**
 * `list` is `itemRows(xs, ctx)`: one `<li>` per item, in order. Each gets a `<blocked-comment>` that can comment on the item or unblock it.
 * Sample data (`live` false) has no server to save to, so no box. Null stays null (nothing is blocked).
 */
export function withComments(list: HTMLElement | null, xs: BlockedItem[], live: boolean): HTMLElement | null {
  if (!list || !live) return list;
  [...list.children].forEach((li, i) => {
    const x = xs[i];
    if (!x) return;
    const box = h('blocked-comment', {});
    box.item = { id: x.id, text: x.text };
    li.append(box);
  });
  return list;
}
