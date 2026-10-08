import { isOpen } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import type { Store } from './store.ts';

/** What closing reads and writes: the store, the fold, and the clock. Nothing here prints or exits. */
export interface CloseContext extends Pick<Store, 'readLedger' | 'append' | 'newId'> {
    fold: (entries: LedgerRow[]) => { items: LedgerItem[] };
    today: () => string;
    now: () => string;
}

/** The outcome of looking a needle up among the items: one match, several, or none. */
export type TargetMatch = { kind: 'found'; target: LedgerItem } | { kind: 'ambiguous'; matches: LedgerItem[] } | { kind: 'not-found' };

/** An exact id wins (open or not); otherwise a case-insensitive text match among the open items, which must be unique. */
export function matchTarget(items: LedgerItem[], needle: string | undefined): TargetMatch {
    if (!needle) return { kind: 'not-found' };
    const exact = items.find((i) => i.id === needle);
    if (exact) return { kind: 'found', target: exact };
    const matches = items.filter(isOpen).filter((i) => i.text?.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 1) return { kind: 'found', target: matches[0] };
    return matches.length > 1 ? { kind: 'ambiguous', matches } : { kind: 'not-found' };
}

export interface CloseRequest {
    /** The row kind to append: `done`, `dropped` or `resolved`. */
    kind: string;
    /** An item id, or text that matches exactly one open item. */
    needle: string | undefined;
    /** The answer or reason; the row text falls back to the item's own text. */
    note?: string | null;
    ticket?: string | null;
    /** Extra row fields (usage marks, approval). A thunk so the caller's own validation runs only once a target is found. */
    extras?: () => object;
    /** Report an item that is already closed instead of appending a second closing row. The CLI appends; the web app skips. */
    skipIfClosed?: boolean;
}

export type CloseResult =
    | { kind: 'closed'; target: LedgerItem; row: LedgerRow; note: string | null }
    | { kind: 'already-closed'; target: LedgerItem }
    | { kind: 'not-closable'; target: LedgerItem; reason: string }
    | { kind: 'ambiguous'; matches: LedgerItem[] }
    | { kind: 'not-found' };

/** Close one item by appending a closing row. Returns what happened; the caller prints, renders and picks the exit code. */
export function closeItem(ctx: CloseContext, req: CloseRequest): CloseResult {
    const entries = ctx.readLedger();
    const found = matchTarget(ctx.fold(entries).items, req.needle);
    if (found.kind !== 'found') return found;
    const { target } = found;
    // A learned row leaves triage box 9 when a composer pass handles it, not when someone closes it by hand.
    if (target.kind === 'learned') return { kind: 'not-closable', target, reason: `${target.id} is a learned row: it is closed only by a composer pass, not by ${req.kind}.` };
    if (req.skipIfClosed && !isOpen(target)) return { kind: 'already-closed', target };
    const note = req.note || null;
    const row = ctx.append({
        id: ctx.newId(entries),
        ts: ctx.now(),
        date: ctx.today(),
        kind: req.kind,
        closes: target.id,
        text: note || target.text,
        repo: target.repo,
        ticket: req.ticket || target.ticket,
        ...req.extras?.(),
    });
    return { kind: 'closed', target, row, note };
}
