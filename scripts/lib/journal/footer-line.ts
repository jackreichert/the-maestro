import type { FooterRow } from './board.ts';
import type { SessionStatus } from '../session-text.ts';

/** What the one-line footer is built from; every part but the ledger rows is optional text or empty. */
export interface FooterLineParts {
    rows: FooterRow[];
    /** The review-queue footer line, with its markup; absent or empty when there is no snapshot. */
    queue?: string;
    /** The `Loop:` line, with its markup; empty when no loop is set up. */
    loop?: string;
    session: SessionStatus;
    /** The orchestrator window this footer is for (lib/window-id.ts); left out when absent. */
    window?: string;
}

const plain = (s: string): string => s.replace(/\*\*/g, '').trim();

/**
 * The reply footer as one line, for a status line or a terse reply: ledger totals across every stream, then the review queue,
 * the loop, the window and the session, joined by ` | `. Parts that are empty are left out. Pure: the numbers are the ones `footerRows`
 * and `sessionStatus` already computed, so it cannot disagree with the multi-line footer.
 */
export function footerOneLine({ rows, queue, loop, session, window }: FooterLineParts): string {
    const sum = (pick: (r: FooterRow) => number): number => rows.reduce((n, r) => n + pick(r), 0);
    const ledger = [
        `${sum((r) => r.done)} done`,
        `${sum((r) => r.inflight)} in flight`,
        ...(sum((r) => r.queued) ? [`${sum((r) => r.queued)} queued`] : []),
        `${sum((r) => r.awaiting)} awaiting`,
        ...(sum((r) => r.paste) ? [`${sum((r) => r.paste)} to run`] : []),
        ...(sum((r) => r.blocked) ? [`${sum((r) => r.blocked)} blocked`] : []),
    ].join(' · ');
    const sess = session.available
        ? `Session: ${session.turns} turns (${session.pct}%) · ${session.readK}k/turn${session.advice ? ` · ${session.advice}` : ''}`
        : `Session: unavailable (${session.unavailable})`;
    return [`Ledger: ${ledger}`, queue ? plain(queue) : '', loop ? plain(loop) : '', window ? `Window: ${window}` : '', sess].filter(Boolean).join(' | ');
}
