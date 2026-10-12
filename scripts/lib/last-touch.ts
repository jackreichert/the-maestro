import type { LedgerItem, LedgerRow } from './ledger-core.ts';

/** Ledger row fields that point at another row's id: any row carrying one of them touched that row. */
export const TOUCH_FIELDS = ['annotates', 'tags', 'carries', 'queues', 'promotes', 'briefs', 'reworks', 'defers', 'leases', 'unleases'] as const;

const dayOf = (r: LedgerRow): string => String(r.date ?? r.ts ?? '').slice(0, 10);

/** The newest day of any row that points at each id through a `TOUCH_FIELDS` field. */
export function touchDates(entries: readonly LedgerRow[]): Map<string, string> {
    const touched = new Map<string, string>();
    for (const r of entries) for (const f of TOUCH_FIELDS) {
        const target = r[f];
        if (typeof target === 'string' && dayOf(r) > (touched.get(target) ?? '')) touched.set(target, dayOf(r));
    }
    return touched;
}

/** The newest of the day a row was opened, the day it last moved state, and the day any row last touched it. The one definition of "last touched". */
export function lastTouchOf(item: Pick<LedgerItem, 'id' | 'date' | 'stateTs'>, touched?: ReadonlyMap<string, string>): string {
    return [String(item.date ?? ''), String(item.stateTs ?? '').slice(0, 10), touched?.get(item.id ?? '') ?? ''].sort().at(-1) as string;
}
