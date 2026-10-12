import { isOpen } from '../ledger-core.ts';
import type { LedgerItem } from '../ledger-core.ts';

/** Why `--parent <id>` is refused, or null when `id` names an open item that is not the new row itself. A closed or unknown parent would never be prompted for. */
export function parentRefusal(items: LedgerItem[], id: string): string | null {
    const parent = items.find((i) => i.id === id);
    if (!parent) return `--parent names no item: ${id}. Nothing was written.`;
    if (!isOpen(parent)) return `--parent ${id} is already ${parent.closedBy?.kind ?? 'closed'}; a child of a closed item would never prompt for it.`;
    return null;
}

/**
 * The parent to offer for closing once `closed` is shut: its `parent` item when that is still open and no other open item names it as
 * parent. Null when `closed` has no parent, the parent is already closed, or a sibling is still open. `items` is the fold read after
 * the closing row was written.
 */
export function orphanedParent(items: LedgerItem[], closed: LedgerItem): LedgerItem | null {
    const id = typeof closed.parent === 'string' ? closed.parent : '';
    if (!id) return null;
    const parent = items.find((i) => i.id === id);
    if (!parent || !isOpen(parent)) return null;
    return items.some((i) => i.id !== closed.id && i.parent === id && isOpen(i)) ? null : parent;
}

/** The line shown after a close that leaves its parent with no open child. */
export const parentPromptLine = (parent: LedgerItem): string =>
    `parent ${parent.id} has no other open child: close it? \`journal.ts done ${parent.id}\`, or \`journal.ts drop ${parent.id}\`   ${parent.text ?? ''}`.trimEnd();
