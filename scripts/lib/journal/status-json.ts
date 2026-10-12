import type { LedgerItem } from '../ledger-core.ts';
import type { LeaseSummary } from './leases.ts';
import type { SessionStatus } from '../session-text.ts';
import { footerDone, footerRows, staleInflight } from './board.ts';
import type { FooterRow, Groups } from './board.ts';

/** What `journal.ts status --json` prints. */
export interface StatusJson {
    date: string;
    inflight: LedgerItem[];
    /** Rows at least `stale_wip_days` old with no live lease: nothing is known to be working on them. Not in `inflight` or its footer count; listed here so they can be closed, dropped or refreshed. Present only when `statusJson` is given leases. */
    stale?: LedgerItem[];
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
export function statusJson(g: Groups, d: string, session: SessionStatus, done?: LedgerItem[], sinceRoll?: LedgerItem[], leases?: LeaseSummary, staleDays?: number): StatusJson {
    const view = done === undefined ? footerDone(g, d) : { all: done, sinceRoll };
    const live = leases ? { today: d, leased: new Set(leases.held.map((h) => h.item)), staleDays } : undefined;
    const stale = live ? staleInflight(g.inflight, live) : undefined;
    return {
        date: d,
        inflight: stale ? g.inflight.filter((i) => !stale.includes(i)) : g.inflight, queued: g.queued, blocked: g.blocked, awaiting: g.awaiting, paste: g.paste, done: view.all,
        footer: { ledger: footerRows(g, view.all, view.sinceRoll, live), session },
        ...(stale ? { stale } : {}),
        ...(leases ? { leases } : {}),
    };
}
