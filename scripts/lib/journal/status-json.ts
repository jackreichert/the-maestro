import type { LedgerItem } from '../ledger-core.ts';
import type { LeaseSummary } from './leases.ts';
import type { SessionStatus } from '../session-text.ts';
import { footerDone, footerRows } from './board.ts';
import type { FooterRow, Groups } from './board.ts';

/** What `journal.ts status --json` prints. */
export interface StatusJson {
    date: string;
    inflight: LedgerItem[];
    queued: LedgerItem[];
    blocked: LedgerItem[];
    awaiting: LedgerItem[];
    paste: LedgerItem[];
    done: LedgerItem[];
    footer: { ledger: FooterRow[]; session: SessionStatus };
    /** Live window leases on open items; present only when `statusJson` is given them. */
    leases?: LeaseSummary;
}

/**
 * The board for day `d` as one object. `done` defaults to everything finished on `d` — the full day, not the
 * since-roll slice. Pass `sinceRoll` when a roll happened that day so the footer can say how many finished after it.
 * A caller that already has the lists passes them to avoid folding twice.
 */
export function statusJson(g: Groups, d: string, session: SessionStatus, done?: LedgerItem[], sinceRoll?: LedgerItem[], leases?: LeaseSummary): StatusJson {
    const view = done === undefined ? footerDone(g, d) : { all: done, sinceRoll };
    return {
        date: d,
        inflight: g.inflight, queued: g.queued, blocked: g.blocked, awaiting: g.awaiting, paste: g.paste, done: view.all,
        footer: { ledger: footerRows(g, view.all, view.sinceRoll), session },
        ...(leases ? { leases } : {}),
    };
}
