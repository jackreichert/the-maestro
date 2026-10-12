import { isOpen } from '../ledger-core.ts';
import type { LedgerItem } from '../ledger-core.ts';
import { closeItem } from './close.ts';
import type { CloseContext } from './close.ts';

/** What `--settles` found for the ids it was given: the open items to close, the ones not open (closed already, or a kind that is never open, such as a learned row), and the ids that are not items. */
export interface SettlePlan { open: LedgerItem[]; notOpen: LedgerItem[]; unknown: string[] }

/** Looks each id up among the items by exact id (never by text: a typo must not close the wrong item). Nothing is written. */
export function planSettle(ctx: CloseContext, ids: string[]): SettlePlan {
    const items = ctx.fold(ctx.readLedger()).items;
    const plan: SettlePlan = { open: [], notOpen: [], unknown: [] };
    for (const id of [...new Set(ids)]) {
        const item = items.find((i) => i.id === id);
        if (!item) plan.unknown.push(id);
        else if (!isOpen(item)) plan.notOpen.push(item);
        else plan.open.push(item);
    }
    return plan;
}

/**
 * Closes each open item in `plan` with a `resolved` row that cites the note that settled it. An item `closeItem` refuses
 * is returned in `refused` and left open. Idempotent: items that are not open are left out of the plan.
 */
export function settleItems(ctx: CloseContext, noteId: string, plan: SettlePlan, extras?: () => object): { closed: LedgerItem[]; refused: { item: LedgerItem; reason: string }[] } {
    const out: { closed: LedgerItem[]; refused: { item: LedgerItem; reason: string }[] } = { closed: [], refused: [] };
    for (const item of plan.open) {
        const result = closeItem(ctx, { kind: 'resolved', needle: item.id, note: `settled by note ${noteId}`, extras });
        if (result.kind === 'closed') out.closed.push(item);
        else if (result.kind === 'not-closable') out.refused.push({ item, reason: result.reason });
    }
    return out;
}
