import { isOpen } from '../ledger-core.ts';
import { orphanedParent } from './parent.ts';
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

/** A pull request named in text: `owner/repo#123` or a bare `#123` (two digits or more, so `#1` in prose is not one). The first one wins. */
export function prRef(text: string | null | undefined): string | null {
    const m = /(?<![\w/#.:-])(?:[\w.-]+\/[\w.-]+)?#(\d{2,})\b/.exec(text ?? '');
    return m ? m[0] : null;
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
    /** On a `resolved` close of an ask that names a PR (in its text or the answer): queue a follow-up item carrying the answer and the PR, so the answer is acted on and not only recorded. Automatic closers leave it off. */
    followUp?: boolean;
    /** A refusal for this open target (the reason), or null to close it. The CLI's `done` passes the retro gate; automatic closers pass none, so they are never blocked. */
    guard?: (target: LedgerItem, entries: LedgerRow[]) => string | null;
}

export type CloseResult =
    /** `parent` is set when this close left the target's parent open with no other open child: the caller offers to close it. */
    | { kind: 'closed'; target: LedgerItem; row: LedgerRow; note: string | null; parent?: LedgerItem; followUp?: LedgerRow }
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
    // A learned or miss row leaves triage when a composer pass handles it, not when someone closes it by hand (verify rejects any other closer).
    if (target.kind === 'learned' || target.kind === 'miss') return { kind: 'not-closable', target, reason: `${target.id} is a ${target.kind} row: it is closed only by a composer pass, not by ${req.kind}.` };
    if (req.skipIfClosed && !isOpen(target)) return { kind: 'already-closed', target };
    const refused = isOpen(target) ? req.guard?.(target, entries) : null;
    if (refused) return { kind: 'not-closable', target, reason: refused };
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
    const parent = orphanedParent(ctx.fold(ctx.readLedger()).items, target);
    const followUp = req.followUp && req.kind === 'resolved' && target.kind === 'question' ? queueFollowUp(ctx, target, note) : null;
    return { kind: 'closed', target, row, note, ...(parent ? { parent } : {}), ...(followUp ? { followUp } : {}) };
}

/** The queued to-do for an answered ask that names a PR; null when it names none, or an open item already carries that PR and ask. */
function queueFollowUp(ctx: CloseContext, ask: LedgerItem, answer: string | null): LedgerRow | null {
    const ref = prRef(`${ask.text ?? ''}\n${answer ?? ''}`);
    if (!ref) return null;
    const entries = ctx.readLedger();
    const marker = `(ask ${ask.id})`;
    if (ctx.fold(entries).items.some((i) => isOpen(i) && i.text?.includes(marker))) return null;
    const clipped = (answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return ctx.append({
        id: ctx.newId(entries),
        ts: ctx.now(),
        date: ctx.today(),
        kind: 'wip',
        queued: true,
        text: `Follow up on ${ref} ${marker}${clipped ? `: ${clipped}` : ''}`,
        stream: ask.stream,
        repo: ask.repo,
        ticket: ask.ticket,
        refs: [ref],
    });
}
