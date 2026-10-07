import { activeDeferrals, isOpen } from '../ledger-core.ts';
import type { LedgerItem } from '../ledger-core.ts';
import { BOX, BOX_TITLES, RECORD_BOXES, ACTIONS, classify, isStale, daysBetween } from '../boxes.ts';
import { clip } from './format.ts';
import { askBits } from './ask-fields.ts';
import { approvalMap } from './approvals.ts';
import { defaultPendingSince, pendingTransitions } from './prime.ts';
import type { PendingContext, PendingRow } from './prime.ts';

/** What triage reads from the run: the ledger, its fold, the clock, and how a --ref resolves to a file. */
export interface TriageContext extends PendingContext { today: () => string; resolveRefFile: (ref: string) => string | null }
/** One boxed item. */
export interface TriageItem {
    id?: string; kind?: string; box: number; date?: string; text?: string; stream?: string; ticket?: string; paste?: string; gate?: string;
    deferredUntil: string | undefined; queued?: true; ref: string | null; ageDays: number; stale: boolean;
    /** The decision fields of an ask in compact words (door, decide-by, class, recommendation, default); absent for any other item and for an ask that carries none. */
    ask?: string[];
}
export interface Blocker { id?: string; box: number; why: string }
export interface TriageReport {
    date: string; since: string; items: TriageItem[]; byBox: Record<number, TriageItem[]>; blockers: Blocker[];
    stale: { id?: string; box: number; ageDays: number }[]; applicable: (string | undefined)[]; pendingTransitions: PendingRow[]; checklist: string[];
}

/**
 * Every item triage looks at, boxed: open items of any age, plus decisions and notes dated since..d that nothing
 * has closed. Each carries `ref` (the first --ref that is an existing file, else null) and `stale`.
 */
export function triageItems(ctx: Pick<TriageContext, 'readLedger' | 'fold' | 'today' | 'resolveRefFile'>, d: string, since: string): TriageItem[] {
    const { readLedger, fold, today, resolveRefFile } = ctx;
    const entries = readLedger();
    const folded = fold(entries);
    const approvals = approvalMap(entries);
    const deferred = activeDeferrals(entries, today());
    const inScope = (i: LedgerItem): boolean => isOpen(i) || (!i.closedBy && ['decision', 'note'].includes(i.kind ?? '') && (i.date ?? '') >= since && (i.date ?? '') <= d);
    return folded.items.filter((i) => !folded.hidden.has(i.id ?? '') && inScope(i)).map((i) => {
        const box = classify(i, approvals.get(i.id ?? ''));
        const ref = (i.refs || []).map(resolveRefFile).find(Boolean) || null;
        const until = deferred.get(i.id ?? '');
        const ask = (i.kind === 'question' || i.kind === 'decision') && !i.paste ? askBits(i) : [];
        return { id: i.id, kind: i.kind, box, date: i.date, text: i.text, stream: i.stream, ticket: i.ticket, paste: i.paste, gate: i.gate, deferredUntil: until, ...(i.queued ? { queued: true as const } : {}), ref, ageDays: daysBetween(i.date, d), stale: !until && isStale(box, i, d), ...(ask.length ? { ask } : {}) };
    });
}

/**
 * The triage report as data. `blockers` are what `roll --strict` refuses on: a rule or approval with no ref file
 * to point at (not yet promoted), and an incidental finding with no ticket. Stale items are warnings only.
 */
export function triageReport(ctx: TriageContext, d: string, since: string = d): TriageReport {
    const items = triageItems(ctx, d, since);
    const byBox: Record<number, TriageItem[]> = {};
    for (const i of items) (byBox[i.box] ||= []).push(i);
    const blockers = [
        ...items.filter((i) => RECORD_BOXES.includes(i.box) && !i.ref).map((i) => ({ id: i.id, box: i.box, why: 'not promoted: no --ref that is an existing file' })),
        ...items.filter((i) => i.box === BOX.FINDING).map((i) => ({ id: i.id, box: i.box, why: 'finding with no ticket' })),
    ];
    const stale = items.filter((i) => i.stale).map((i) => ({ id: i.id, box: i.box, ageDays: i.ageDays }));
    const applicable = items.filter((i) => RECORD_BOXES.includes(i.box) && i.ref).map((i) => i.id);
    const pending = pendingTransitions(ctx, defaultPendingSince());
    return { date: d, since, items, byBox, blockers, stale, applicable, pendingTransitions: pending, checklist: triageChecklist(items, blockers, pending) };
}

/** The don't-miss checklist: [x]/[ ] where the ledger can tell, "(by hand)" where only the session can. */
export function triageChecklist(items: TriageItem[], blockers: Blocker[], pending: PendingRow[] = []): string[] {
    const n = (box: number): TriageItem[] => items.filter((i) => i.box === box);
    const unpromoted = blockers.filter((b) => RECORD_BOXES.includes(b.box)).length;
    const toClose = items.filter((i) => RECORD_BOXES.includes(i.box) && i.ref).length;
    const short = n(BOX.NEEDS_JACK).filter((i) => String(i.text).trim().length < 25).length;
    const unfiled = n(BOX.PASTE).filter((i) => !i.paste).length;
    const mark = (ok: unknown): string => (ok ? '[x]' : '[ ]');
    return [
        `${mark(!unpromoted && !toClose)} Every rule or approval stated today has a memory file and a HOW-WE-WORK line (by hand), and its ledger row is closed${unpromoted ? ` (${unpromoted} with no ref file)` : ''}${toClose ? ` (${toClose} ready: run \`triage --apply\`)` : ''}`,
        `${mark(!n(BOX.FINDING).length)} Every "could not be filed", "follow-up", "next session" note is a ticket or an open item${n(BOX.FINDING).length ? ` (${n(BOX.FINDING).length} without one)` : ''}. Check the handoff draft by hand too.`,
        `${mark(!short)} Every Needs-Jack item reads as a standalone question with options, not a bare id${short ? ` (${short} too short to stand alone)` : ''}`,
        `${mark(!unfiled)} Paste blocks are listed separately, each with a file link${unfiled ? ` (${unfiled} with no block file; re-ask with --paste)` : ''}`,
        `${mark(!n(BOX.GATED).filter((i) => !i.gate).length)} Every gated item names its gate (--gate)${n(BOX.GATED).filter((i) => !i.gate).length ? ` (${n(BOX.GATED).filter((i) => !i.gate).length} without one)` : ''}`,
        `${mark(!pending.length)} Every done item with a tracker key has a recorded transition${pending.length ? ` (${pending.length} pending: ${pending.map((r) => r.key).join(', ')}; run \`tickets --pending\`)` : ''}`,
        `[ ] Every in-flight item matches a running agent or a worktree: ListAgents, branch-sweep (by hand)${n(BOX.INFLIGHT).some((i) => i.queued) ? `; ${n(BOX.INFLIGHT).filter((i) => i.queued).length} queued to-do(s) in box 7 have not started, so skip them` : ''}`,
        '[ ] Session turn count and read/turn are in the handoff (`handoff` fills them from token-metrics.ts; by hand if you wrote it yourself)',
    ];
}

export function triageLines(t: TriageReport): string[] {
    const out = [`Triage — ${t.date} (open items, plus decisions and notes since ${t.since})`];
    for (const box of Object.keys(t.byBox).map(Number).sort((a, b) => a - b)) {
        const list = t.byBox[box];
        if (box === BOX.NOISE) { out.push(`\nBox ${box} ${BOX_TITLES[box]} (${list.length}): ${ACTIONS[box]}`); continue; }
        out.push(`\nBox ${box} ${BOX_TITLES[box]} (${list.length}): ${ACTIONS[box]}`);
        for (const i of list) {
            const tail = [...(i.ask ?? []), i.queued ? 'queued: not started' : null, RECORD_BOXES.includes(box) ? (i.ref ? `ref ${i.ref}` : 'NO REF') : null, i.stale ? `STALE ${i.ageDays}d` : null, i.deferredUntil ? `deferred until ${i.deferredUntil}` : null, i.gate ? `gate ${i.gate}` : null, i.paste ? `block ${i.paste}` : null].filter(Boolean);
            out.push(`  ${i.id}  ${clip(i.text, 110)}${tail.length ? `  [${tail.join('; ')}]` : ''}`);
        }
    }
    if (!t.items.length) out.push('\n  (nothing to box)');
    out.push('', `Blockers (roll --strict refuses): ${t.blockers.length}`);
    t.blockers.forEach((b) => out.push(`  ${b.id}  box ${b.box}: ${b.why}`));
    out.push(`Stale: ${t.stale.length}${t.stale.length ? ` (${t.stale.map((s) => `${s.id} ${s.ageDays}d`).join(', ')})` : ''}`);
    out.push('', "Don't-miss checklist", ...t.checklist.map((l) => `  ${l}`));
    return out;
}
