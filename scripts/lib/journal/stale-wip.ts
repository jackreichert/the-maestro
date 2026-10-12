import type { LedgerItem } from '../ledger-core.ts';
import { clip } from './format.ts';
import { staleInflight } from './board.ts';
import type { FooterLiveness } from './board.ts';

/** The open in-flight rows split by whether anything is known to be working on them. */
export interface InflightSplit {
    /** In flight and either young or holding a live lease. */
    live: LedgerItem[];
    /** At least `stale_wip_days` old with no live lease: still open, but counted apart from live work. */
    stale: LedgerItem[];
}

/** Split `inflight` into live and stale rows; each row lands in exactly one list and the order is kept. */
export function splitInflight(inflight: LedgerItem[], live: FooterLiveness): InflightSplit {
    const stale = staleInflight(inflight, live);
    const gone = new Set(stale);
    return { live: inflight.filter((i) => !gone.has(i)), stale };
}

/** How many days old a row is on `today`; a date that cannot be read counts as 0 so it never reads as old. */
const ageDays = (date: string | undefined, today: string): number => {
    const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date ?? ''}T00:00:00Z`)) / 86_400_000;
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
};

/**
 * What `roll` prints for stale rows: each id with its age, stream and text, then the three ways to settle it. Nothing is closed here;
 * the row is shut by the person or agent who knows whether the work finished. No lines when nothing is stale.
 */
export function staleRollLines(stale: LedgerItem[], today: string, staleDays: number): string[] {
    if (!stale.length) return [];
    const oldest = [...stale].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return [
        `Stale in flight: ${stale.length} row(s) with no lease for ${staleDays}d or more. Close, drop or refresh each:`,
        ...oldest.map((i) => `  ${i.id}  ${ageDays(i.date, today)}d${i.stream ? `  [${i.stream}]` : ''}  ${clip(i.text, 100)}`),
        '  finished: `journal.ts done <id>`   abandoned: `journal.ts drop <id>`   still going: `journal.ts lease <id>`',
    ];
}
