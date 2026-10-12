import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInFlight, isOpen } from './ledger-core.ts';
import type { LedgerItem, LedgerRow } from './ledger-core.ts';
import { daysBetween } from './boxes.ts';

/** What is known about one open in-flight row, gathered without writing anything or calling the network. */
export interface StaleEvidence {
    id: string;
    stream: string | null;
    text: string;
    /** Date the row was opened, and the newest date of any row that touched it (a note, tag, carry, brief, lease, annotation). */
    opened: string;
    lastTouch: string;
    ageDays: number;
    idleDays: number;
    ticket: string | null;
    /** The `status` of the vault ticket note, or null when no ticket is named, no vault was given or the note is not there. */
    ticketStatus: string | null;
    /** Rows that name this one as their `parent`: how many exist and how many are still open. */
    children: { total: number; open: number };
    /** PR references in the row text, as `owner/repo#N`; their state needs GitHub, so the runbook checks them with pr-state.ts. */
    prRefs: string[];
    /** `close` when hard evidence says the work is over (ticket closed, or every child closed); otherwise `ask`. */
    proposal: 'close' | 'ask';
    /** The hard evidence behind a `close` proposal, in words; empty for `ask`. */
    because: string[];
}

/** Ledger row fields that point at another row's id: any row carrying one of them touched that row. */
const TOUCH_FIELDS = ['annotates', 'tags', 'carries', 'queues', 'promotes', 'briefs', 'reworks', 'defers', 'leases', 'unleases'] as const;
const CLOSED_TICKET = new Set(['closed', 'done', 'dropped', 'resolved', 'cancelled', 'canceled', 'superseded']);

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const PR_SHORT = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;

/** `owner/repo#N` references in `text`, deduplicated, in order of appearance. */
export function prRefsIn(text: string): string[] {
    const seen = new Set<string>();
    for (const m of text.matchAll(PR_URL)) seen.add(`${m[1]}#${m[2]}`);
    for (const m of text.matchAll(PR_SHORT)) seen.add(`${m[1]}#${m[2]}`);
    return [...seen];
}

/** The `status` of ticket `id` in `<ticketsVault>/Projects/<project>/Tickets/<id>.md`, where the project is the id without its trailing number. Null when unreadable. */
export function ticketStatus(ticketsVault: string | undefined, id: string): string | null {
    if (!ticketsVault || !/^[\w.-]+-\d+$/.test(id)) return null;
    const file = join(ticketsVault, 'Projects', id.replace(/-\d+$/, ''), 'Tickets', `${id}.md`);
    if (!existsSync(file)) return null;
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
    return /^status:\s*"?([\w-]+)"?\s*$/m.exec(front?.[1] ?? '')?.[1] ?? null;
}

const dayOf = (r: LedgerRow): string => String(r.date ?? r.ts ?? '').slice(0, 10);

/**
 * Evidence for every open in-flight item (queued and deferred rows are not in-flight), oldest first. `today` is the day it is read on.
 * Read-only: `entries` is the raw ledger, `items` its fold, `ticketsVault` an optional notes vault.
 */
export function staleEvidence(entries: LedgerRow[], items: LedgerItem[], today: string, ticketsVault?: string): StaleEvidence[] {
    const touched = new Map<string, string>();
    for (const r of entries) for (const f of TOUCH_FIELDS) {
        const target = r[f];
        if (typeof target === 'string' && dayOf(r) > (touched.get(target) ?? '')) touched.set(target, dayOf(r));
    }
    return items.filter((i) => isOpen(i) && isInFlight(i)).map((i) => {
        const id = String(i.id);
        const kids = items.filter((k) => k.parent === id);
        const children = { total: kids.length, open: kids.filter(isOpen).length };
        const status = i.ticket ? ticketStatus(ticketsVault, i.ticket) : null;
        const because = [
            ...(status && CLOSED_TICKET.has(status) ? [`ticket ${i.ticket} is ${status}`] : []),
            ...(children.total && !children.open ? [`all ${children.total} child row(s) are closed`] : []),
        ];
        const opened = String(i.date ?? '');
        const lastTouch = [opened, touched.get(id) ?? ''].sort().at(-1) as string;
        return {
            id, stream: i.stream ?? null, text: String(i.text ?? ''), opened, lastTouch,
            ageDays: daysBetween(opened, today), idleDays: daysBetween(lastTouch, today),
            ticket: i.ticket ?? null, ticketStatus: status, children, prRefs: prRefsIn(`${i.text ?? ''} ${(i.refs ?? []).join(' ')}`),
            proposal: because.length ? 'close' : 'ask', because,
        } satisfies StaleEvidence;
    }).sort((a, b) => a.opened.localeCompare(b.opened));
}

/** The evidence as plain text, one block per row, then the totals. */
export function renderEvidence(rows: StaleEvidence[], today: string): string[] {
    const out = [`Open in-flight rows on ${today}: ${rows.length} (${rows.filter((r) => r.proposal === 'close').length} with hard evidence to close, ${rows.filter((r) => r.proposal === 'ask').length} for a batch ask)`];
    for (const r of rows) {
        out.push('', `${r.id}  [${r.stream ?? 'other'}]  opened ${r.opened} (${r.ageDays}d), last touched ${r.lastTouch} (${r.idleDays}d)  ${r.proposal.toUpperCase()}`, `  ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`);
        out.push(`  ticket: ${r.ticket ? `${r.ticket} (${r.ticketStatus ?? 'status unknown'})` : 'none'} · children: ${r.children.total ? `${r.children.total - r.children.open} of ${r.children.total} closed` : 'none'} · PRs: ${r.prRefs.length ? r.prRefs.join(', ') : 'none named'}`);
        if (r.because.length) out.push(`  because: ${r.because.join('; ')}`);
    }
    return out;
}
