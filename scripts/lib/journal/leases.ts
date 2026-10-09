import type { LedgerRow } from '../ledger-core.ts';

/**
 * Leases: which orchestrator window is working a ledger item, so two windows on one project do not both take it.
 *
 * A lease is two kinds of ledger row, folded in file order (the ledger is the only store):
 *   { kind: 'lease', leases: <item id>, window, ts, ttl: <minutes>, steal?: true }
 *   { kind: 'unlease', unleases: <item id>, window, force?: true }
 * (and a new in-flight `wip` row with `leaseTtl: <minutes>`, which leases its own id in the same row)
 * The fold decides who holds an item. A `lease` row takes effect only if nobody else held a live lease at that
 * row's own timestamp (or it says `steal`), so a row that lost a race is simply ignored. Rows are appended with
 * O_APPEND, which orders them totally, so of any number of windows racing for one item the earliest row in the
 * file wins and every later reader folds to the same holder. A closing row (`done`, `drop`, `resolve`) ends the lease.
 * A lease runs for its `ttl` from its last renewal; any row its holder writes renews it, so a working window keeps
 * its leases and a window that died, or whose id changed at /clear, lets them lapse.
 */

export interface Lease { item: string; holder: string; since: string; until: number; ttlMs: number }

const MIN_MS = 60_000;
const ms = (ts: unknown): number => (typeof ts === 'string' ? Date.parse(ts) : NaN);

/** Every lease the ledger records, live or lapsed (see `liveLease`), keyed by item id. */
export function foldLeases(entries: readonly LedgerRow[]): Map<string, Lease> {
    const held = new Map<string, Lease>();
    for (const e of entries) {
        const at = ms(e.ts);
        if (typeof e.closes === 'string') held.delete(e.closes);
        if (!Number.isFinite(at) || !e.window) continue;
        // A `lease` row names the item; a new in-flight `wip` row that carries `leaseTtl` leases its own id (the `start "<text>"` row).
        const item = e.kind === 'lease' ? e.leases : e.kind === 'wip' && !e.queued && e.leaseTtl !== undefined ? e.id : undefined;
        if (typeof item === 'string') {
            const cur = held.get(item);
            const free = !cur || cur.until <= at || cur.holder === e.window || e.steal === true;
            if (free) {
                const minutes = Number(e.kind === 'lease' ? e.ttl : e.leaseTtl);
                const ttlMs = (minutes > 0 ? minutes : 1) * MIN_MS;
                held.set(item, { item, holder: e.window, since: cur?.holder === e.window ? cur.since : (e.ts as string), until: at + ttlMs, ttlMs });
            }
            continue;
        }
        if (e.kind === 'unlease' && typeof e.unleases === 'string') {
            const cur = held.get(e.unleases);
            if (cur && (cur.holder === e.window || e.force === true)) held.delete(e.unleases);
            continue;
        }
        // Any other row by the holder is activity: it renews every lease that window still holds.
        for (const l of held.values()) if (l.holder === e.window && l.until > at) l.until = Math.max(l.until, at + l.ttlMs);
    }
    return held;
}

/** The lease on `item` if it has not lapsed at `nowMs`. */
export function liveLease(held: Map<string, Lease>, item: string, nowMs: number): Lease | undefined {
    const l = held.get(item);
    return l && l.until > nowMs ? l : undefined;
}

/** The live leases on items still open, with how many this window holds (`mine`) and how many other windows hold (`other`). */
export interface LeaseSummary { window: string; mine: number; other: number; held: { item: string; holder: string; until: string }[] }
export function summarizeLeases(held: Map<string, Lease>, window: string, nowMs: number, isOpenItem: (id: string) => boolean): LeaseSummary {
    const live = [...held.values()].filter((l) => l.until > nowMs && isOpenItem(l.item));
    const mine = live.filter((l) => l.holder === window).length;
    return { window, mine, other: live.length - mine, held: live.map((l) => ({ item: l.item, holder: l.holder, until: new Date(l.until).toISOString() })) };
}

export const describeLease = (l: Lease): string => `leased by ${l.holder} until ${new Date(l.until).toISOString().slice(0, 16)}Z`;

/** What a lease needs from the run: the ledger, an append, this window, and the clock. */
export interface LeaseContext {
    readLedger: () => LedgerRow[];
    append: (row: LedgerRow) => unknown;
    window: string;
    now: () => string;
    dryRun: boolean;
}

export type Acquired = { ok: true; lease: Lease; wrote: boolean } | { ok: false; lease: Lease };

/**
 * Take (or renew) the lease on `item` for this window. Refused without writing when another window holds a live
 * lease and `steal` is not set. Otherwise it appends a `lease` row and folds the ledger again: the row only counts
 * if it came first, so a window that lost a race to another reads that other window as the holder and is refused.
 */
export function acquireLease(ctx: LeaseContext, item: string, opts: { ttlMinutes: number; steal?: boolean; text?: string }): Acquired {
    const nowMs = Date.parse(ctx.now());
    const before = liveLease(foldLeases(ctx.readLedger()), item, nowMs);
    if (before && before.holder !== ctx.window && !opts.steal) return { ok: false, lease: before };
    // Already ours with more than half its time left: activity renews it, so there is nothing to write.
    if (before && before.holder === ctx.window && before.until - nowMs > before.ttlMs / 2) return { ok: true, lease: before, wrote: false };
    const row: LedgerRow = { ts: ctx.now(), date: ctx.now().slice(0, 10), kind: 'lease', leases: item, window: ctx.window, ttl: opts.ttlMinutes, text: opts.text ?? `lease ${item}` };
    if (opts.steal && before && before.holder !== ctx.window) { row.steal = true; row.from = before.holder; }
    ctx.append(row);
    if (ctx.dryRun) return { ok: true, lease: { item, holder: ctx.window, since: row.ts as string, until: nowMs + opts.ttlMinutes * MIN_MS, ttlMs: opts.ttlMinutes * MIN_MS }, wrote: true };
    const after = liveLease(foldLeases(ctx.readLedger()), item, Date.parse(ctx.now()));
    return after && after.holder === ctx.window ? { ok: true, lease: after, wrote: true } : { ok: false, lease: after ?? before! };
}

/** Free the lease on `item`: the holder's own, or any with `force`. Returns the lease that was freed, or why not. */
export function releaseLease(ctx: LeaseContext, item: string, force: boolean): { freed: Lease } | { none: true } | { heldBy: Lease } {
    const cur = liveLease(foldLeases(ctx.readLedger()), item, Date.parse(ctx.now()));
    if (!cur) return { none: true };
    if (cur.holder !== ctx.window && !force) return { heldBy: cur };
    ctx.append({ ts: ctx.now(), date: ctx.now().slice(0, 10), kind: 'unlease', unleases: item, window: ctx.window, ...(force && cur.holder !== ctx.window ? { force: true, from: cur.holder } : {}), text: `unlease ${item}` });
    return { freed: cur };
}
