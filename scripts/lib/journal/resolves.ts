import type { LedgerItem } from '../ledger-core.ts';
import { isAgeable } from './age-out.ts';
import { closeItem } from './close.ts';
import type { CloseContext } from './close.ts';
import { planSettle } from './settle.ts';
import type { SettlePlan } from './settle.ts';

/**
 * `--resolves`, `--supersedes` and `--folds`: the row being written closes the awaiting asks and queued to-dos it names, so the
 * answer, the replacement or the fold-in is one command and not a second `done` someone forgets. They differ only in the closing
 * row: `--resolves` writes `resolved` (the thing is answered or landed), `--supersedes` and `--folds` write `dropped` pointing at
 * the new row (a duplicate, or work absorbed into it). Only awaiting and queued rows can be named: an in-flight row is closed by
 * whoever did the work, so naming one is refused and nothing is written.
 */
export interface Closing { flag: 'resolves' | 'supersedes' | 'folds'; kind: 'resolved' | 'dropped'; phrase: string }

export const CLOSINGS: Closing[] = [
    { flag: 'resolves', kind: 'resolved', phrase: 'resolved by' },
    { flag: 'supersedes', kind: 'dropped', phrase: 'superseded by' },
    { flag: 'folds', kind: 'dropped', phrase: 'folded into' },
];

/** The named ids split by what can be done with them; `blocked` are open rows age-out never closes (in flight, blocked, a learned row). */
export interface ClosingPlan extends SettlePlan { blocked: LedgerItem[] }

/** Looks each id up by exact id and sorts it; nothing is written. */
export function planClosing(ctx: CloseContext, ids: string[]): ClosingPlan {
    const base = planSettle(ctx, ids);
    return { ...base, open: base.open.filter(isAgeable), blocked: base.open.filter((i) => !isAgeable(i)) };
}

/** Why a plan must stop before anything is written, or null. */
export function planRefusal(flag: Closing['flag'], plan: ClosingPlan): string | null {
    if (plan.unknown.length) return `--${flag} names no item: ${plan.unknown.join(', ')}. Nothing was written.`;
    if (plan.blocked.length) return `--${flag} can close only awaiting asks and queued to-dos; ${plan.blocked.map((i) => `${i.id} is ${i.queued ? 'queued' : i.kind === 'wip' ? 'in flight' : i.kind}`).join(', ')}. Close those with done or drop. Nothing was written.`;
    return null;
}

/** Closes each open row in the plan, citing `newId`. Returns the ids closed; a row `closeItem` refuses is left open and returned in `refused`. */
export function applyClosing(ctx: CloseContext, newId: string, plan: ClosingPlan, closing: Closing, extras?: () => object): { closed: LedgerItem[]; refused: { item: LedgerItem; reason: string }[] } {
    const out = { closed: [] as LedgerItem[], refused: [] as { item: LedgerItem; reason: string }[] };
    for (const item of plan.open) {
        const r = closeItem(ctx, { kind: closing.kind, needle: item.id, note: `${closing.phrase} ${newId}`, extras, skipIfClosed: true });
        if (r.kind === 'closed') out.closed.push(item);
        else if (r.kind === 'not-closable') out.refused.push({ item, reason: r.reason });
    }
    return out;
}

/** The flag set on this command line, if any. At most one is allowed: two closings on one row would not say which row replaced which. */
export function chosenClosing(has: (flag: string) => boolean): Closing | null | 'many' {
    const set = CLOSINGS.filter((c) => has(c.flag));
    return set.length > 1 ? 'many' : set[0] ?? null;
}
