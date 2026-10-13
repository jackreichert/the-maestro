import { isInFlight } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { liveAgent } from './agent-rows.ts';
import { foldLeases } from './leases.ts';

export { liveAgent };
import type { Lease } from './leases.ts';

/**
 * Requeue: an in-flight row whose lease has lapsed, with no agent still working it, goes back to queued, so the board stops
 * calling abandoned work "in flight". Two triggers share this module: a lapsed lease found at the footer heartbeat or `maintain`,
 * and the SessionEnd hook, which requeues the leases of the window that is ending. Only a row that was once leased is touched: a
 * row nobody ever leased is left to the stale-in-flight warning, because there is no evidence its owner is gone.
 *
 * Pure: it reads rows and returns the rows to append. The caller appends them, so a dry run writes nothing.
 */

/** A `queue` row (the same shape `journal.ts queue <id>` writes), with the reason in its text. */
const queueRow = (item: LedgerItem, why: string, at: string, base: Partial<LedgerRow>): LedgerRow => (
    { ...base, ts: at, date: at.slice(0, 10), kind: 'queue', queues: item.id, text: `queue ${item.text} (${why})` } as LedgerRow
);

/** `queue` rows for each in-flight item whose lease lapsed with no live agent. `base` carries the usage marks the caller stamps on its rows. */
export function lapsedRequeues(rows: readonly LedgerRow[], items: readonly LedgerItem[], nowMs: number, base: Partial<LedgerRow> = {}): LedgerRow[] {
    const held = foldLeases(rows);
    const at = new Date(nowMs).toISOString();
    return items
        .filter((i) => i.id && isInFlight(i))
        .filter((i) => { const l: Lease | undefined = held.get(i.id as string); return !!l && l.until <= nowMs && !liveAgent(rows, i.id as string, nowMs); })
        .map((i) => queueRow(i, 'lease lapsed, no agent running', at, base));
}

/** `queue` and `unlease` rows for every in-flight item `window` holds a live lease on, for the SessionEnd hook. */
export function windowRequeues(rows: readonly LedgerRow[], items: readonly LedgerItem[], window: string, nowMs: number, base: Partial<LedgerRow> = {}): LedgerRow[] {
    const held = foldLeases(rows);
    const at = new Date(nowMs).toISOString();
    return items
        .filter((i) => i.id && isInFlight(i) && held.get(i.id as string)?.holder === window && (held.get(i.id as string)?.until ?? 0) > nowMs)
        .flatMap((i) => [
            queueRow(i, `window ${window} ended`, at, { ...base, window }),
            { ...base, ts: at, date: at.slice(0, 10), kind: 'unlease', unleases: i.id, window, text: `unlease ${i.id} (window ended)` } as LedgerRow,
        ]);
}
