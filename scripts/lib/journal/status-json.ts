import type { LedgerItem } from '../ledger-core.ts';
import type { SessionStatus } from '../session-text.ts';
import { footerRows } from './board.ts';
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
}

/**
 * The board for day `d` as one object. `done` defaults to the items finished on `d` since the last roll, which is
 * what the CLI shows; a caller that already has that list passes it to avoid folding twice.
 */
export function statusJson(g: Groups, d: string, session: SessionStatus, done: LedgerItem[] = g.doneOn(d, { sinceRoll: true })): StatusJson {
    return {
        date: d,
        inflight: g.inflight, queued: g.queued, blocked: g.blocked, awaiting: g.awaiting, paste: g.paste, done,
        footer: { ledger: footerRows(g, done), session },
    };
}
