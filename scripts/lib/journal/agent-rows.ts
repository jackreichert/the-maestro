import { isInFlight } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { foldLeases } from './leases.ts';

/**
 * The ledger side of an Agent dispatch. Two hooks call this: PreToolUse(Agent) before a subagent starts, SubagentStop when one
 * ends. A dispatch ties the agent to an in-flight row that carries a lease; the stop marks that row "returned, verify", so the
 * work is never silently finished. Pure: rows in, rows out. The hooks append them and fail open around it.
 *
 * Row contract (the fold in leases.ts and `liveAgent` read these):
 *   dispatch: { kind: 'lease', leases: <id>, ttl: AGENT_TTL_MINUTES, agent: true, agentType }   (the marked lease: an agent is out)
 *             { kind: 'next', nexts: <id>, nextStep: 'agent running: ...' }
 *   return:   { kind: 'next', nexts: <id>, nextStep: AGENT_RETURNED_STEP, agentReturned: true, agentType }
 *             { kind: 'lease', leases: <id>, ttl: RETURNED_TTL_MINUTES }   (shortens the lease, so an unverified row lapses and requeues)
 */

/** The next step the stop hook records on a row whose agent has stopped; the footer counts such rows as "to verify", not in flight. */
import { AGENT_RETURNED_STEP } from '../ledger-core.ts';
export { AGENT_RETURNED_STEP };

/** How long a dispatched agent keeps its row leased: past the longest agents run, so a live one is never requeued under it. */
export const AGENT_TTL_MINUTES = 240;
/** How long a returned row stays leased for its dispatcher to verify the hand-back before it lapses and requeues. */
export const RETURNED_TTL_MINUTES = 60;

export interface Dispatch { item: string; ts: string; ttl: number; agentType: string; /** The harness's id for the Agent call; set when the hook was given one, so a stop can name the exact dispatch. */ toolUseId?: string }

const typeOf = (r: LedgerRow): string => (typeof r.agentType === 'string' ? r.agentType : '');

/** Dispatches that have not returned, oldest first, per item. A return pops the oldest of its type (else the oldest); a closing row empties the item. */
export function openDispatches(rows: readonly LedgerRow[]): Map<string, Dispatch[]> {
    const out = new Map<string, Dispatch[]>();
    for (const r of rows) {
        if (r.kind === 'lease' && r.agent === true && typeof r.leases === 'string') {
            out.set(r.leases, [...(out.get(r.leases) ?? []), { item: r.leases, ts: String(r.ts), ttl: Number(r.ttl), agentType: typeOf(r), ...(typeof r.toolUseId === 'string' && r.toolUseId ? { toolUseId: r.toolUseId } : {}) }]);
        } else if (r.kind === 'next' && r.agentReturned === true && typeof r.nexts === 'string') {
            const q = out.get(r.nexts) ?? [];
            const exact = typeof r.toolUseId === 'string' && r.toolUseId ? q.findIndex((d) => d.toolUseId === r.toolUseId) : -1;
            const at = exact >= 0 ? exact : Math.max(0, q.findIndex((d) => d.agentType === typeOf(r)));
            out.set(r.nexts, q.filter((_, n) => n !== at));
        } else if (typeof r.closes === 'string') out.delete(r.closes);
    }
    return out;
}

/** True while an agent dispatched on `item` has not returned and its marked lease has not run out. */
export function liveAgent(rows: readonly LedgerRow[], item: string, nowMs: number): boolean {
    return (openDispatches(rows).get(item) ?? []).some((d) => Date.parse(d.ts) + d.ttl * 60_000 > nowMs);
}

export interface DispatchInput { window: string; description?: string; prompt?: string; agentType?: string; toolUseId?: string }

const oneLine = (s: unknown, max = 120): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The in-flight row this window already holds a live lease on that the dispatch is about: its id appears in the prompt, or its text
 * contains the description. Null when nothing matches; the hook then opens a row rather than guessing at one.
 */
export function rowForDispatch(rows: readonly LedgerRow[], items: readonly LedgerItem[], input: DispatchInput, nowMs: number): LedgerItem | null {
    const held = foldLeases(rows);
    const prompt = String(input.prompt ?? '');
    const desc = oneLine(input.description).toLowerCase();
    // A lapsed lease still counts when this window was its last holder: a re-dispatch an hour after its last ledger write is about the same row.
    const mine = items.filter((i) => i.id && isInFlight(i) && held.get(i.id)?.holder === input.window);
    return mine.find((i) => prompt.includes(i.id as string)) ?? (desc ? mine.find((i) => String(i.text ?? '').toLowerCase().includes(desc)) : undefined) ?? null;
}

/** Rows to append for a dispatch. `newId` hands out ids not yet taken; `base` carries the usage marks the hook stamps on its rows. */
export function dispatchRows(rows: readonly LedgerRow[], items: readonly LedgerItem[], input: DispatchInput, nowMs: number, newId: () => string, base: Partial<LedgerRow> = {}): LedgerRow[] {
    const at = new Date(nowMs).toISOString();
    const stamp = { ...base, ts: at, date: at.slice(0, 10), window: input.window };
    const found = rowForDispatch(rows, items, input, nowMs);
    const desc = oneLine(input.description) || 'agent dispatch';
    const id = found?.id ?? newId();
    const opened: LedgerRow[] = found ? [] : [{ ...stamp, id, kind: 'wip', text: desc, leaseTtl: AGENT_TTL_MINUTES, hookOpened: true } as LedgerRow];
    return [
        ...opened,
        { ...stamp, id: newId(), kind: 'lease', leases: id, ttl: AGENT_TTL_MINUTES, agent: true, agentType: input.agentType ?? '', ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}), text: `agent dispatched on ${id}` } as LedgerRow,
        { ...stamp, id: newId(), kind: 'next', nexts: id, nextStep: `agent running: ${desc}`, text: `next ${id}: agent running: ${desc}` } as LedgerRow,
    ];
}

/** Rows to append when an agent of `agentType` stops: the one unreturned dispatch of this window that fits is marked returned. Empty when none is open or when dispatches on more than one row fit (the stop cannot say which). */
export function returnRows(rows: readonly LedgerRow[], window: string, agentType: string, nowMs: number, newId: () => string, base: Partial<LedgerRow> = {}, toolUseId = ''): LedgerRow[] {
    const held = foldLeases(rows);
    const open = openDispatches(rows);
    const mine = [...open.values()].flat().filter((d) => held.get(d.item)?.holder === window);
    const pick = [...mine].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // A stop that names the Agent call it ends (the harness's tool-use id, read from the subagent's own meta file) is paired exactly; otherwise by agent type.
    const exact = toolUseId ? pick.filter((x) => x.toolUseId === toolUseId) : [];
    const same = pick.filter((x) => x.agentType === agentType);
    const candidates = exact.length ? exact : same.length ? same : pick;
    // Dispatches on two or more rows fit and a stop carries nothing to tell them apart: guessing would shorten the lease of a row whose agent is still running. Write nothing; each dispatch lease lapses on its own.
    if (new Set(candidates.map((x) => x.item)).size !== 1) return [];
    const d = candidates[0];
    const at = new Date(nowMs).toISOString();
    const stamp = { ...base, ts: at, date: at.slice(0, 10), window };
    const ref = d.toolUseId ? { toolUseId: d.toolUseId } : {};
    // Only dispatches still inside their lease count as out: one whose stop never fired (a killed agent) must not hold the row open forever.
    const others = (open.get(d.item) ?? []).filter((x) => x !== d && Date.parse(x.ts) + x.ttl * 60_000 > nowMs).length;
    // Another agent is still out on this row: record this stop (so it is not counted twice) but leave the row in flight with its lease.
    if (others > 0) return [{ ...stamp, id: newId(), kind: 'next', nexts: d.item, nextStep: `agent running: ${others} still out`, agentReturned: true, agentType: d.agentType, ...ref, text: `next ${d.item}: agent running: ${others} still out` } as LedgerRow];
    return [
        { ...stamp, id: newId(), kind: 'next', nexts: d.item, nextStep: AGENT_RETURNED_STEP, agentReturned: true, agentType: d.agentType, ...ref, text: `next ${d.item}: ${AGENT_RETURNED_STEP}` } as LedgerRow,
        { ...stamp, id: newId(), kind: 'lease', leases: d.item, ttl: RETURNED_TTL_MINUTES, text: `lease ${d.item} (returned, verify)` } as LedgerRow,
    ];
}
