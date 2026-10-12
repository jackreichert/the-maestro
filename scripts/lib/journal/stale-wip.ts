import type { LedgerItem } from '../ledger-core.ts';
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
