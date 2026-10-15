/**
 * `journal.ts query`: read-only, capped filters over the folded ledger items, and `ready-to-push`: local branches of mine whose work has
 * not reached a remote. Pure filter here; the command does the reads and the printing.
 */
import { canonicalModel, isInFlight, isOpen, isQueued } from '../ledger-core.ts';
import type { LedgerItem } from '../ledger-core.ts';

export const QUERY_DEFAULT_LIMIT = 50;
export const QUERY_MAX_LIMIT = 200;
export const QUERY_STATUSES = ['open', 'inflight', 'queued', 'blocked', 'done', 'dropped', 'resolved', 'closed', 'all'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export interface QueryFilter {
    /** Canonical stream name (the caller normalises aliases). */
    stream?: string;
    id?: string;
    status?: QueryStatus;
    /** YYYY-MM-DD. `date` is one day; `since` and `until` bound a range, both inclusive. The day is the closing row's for a closed item, else the item's own. */
    date?: string;
    since?: string;
    until?: string;
    /** Model name, compared case-insensitively. */
    model?: string;
    limit?: number;
}

export interface QueryRow { id: string; kind: string; status: string; stream: string | null; repo: string | null; ticket: string | null; model: string | null; date: string | null; text: string }
export interface QueryResult { total: number; shown: number; limit: number; rows: QueryRow[] }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 200;

/** The item's state as one word: `done`, `dropped`, `resolved` once closed, else `inflight`, `queued`, `blocked` or `open`. */
export function statusOf(i: LedgerItem): string {
    const closedBy = (i as { closedBy?: { kind?: string } | null }).closedBy;
    if (closedBy) return closedBy.kind ?? 'closed';
    if (isQueued(i)) return 'queued';
    if (isInFlight(i)) return 'inflight';
    return i.kind === 'blocked' ? 'blocked' : 'open';
}

/** The day an item counts for in a date filter: when it closed, else its own date. */
const dayOf = (i: LedgerItem): string | undefined => (i as { closedBy?: { date?: string } | null }).closedBy?.date ?? i.date;

/** A usage error as text, or null when the filter is well formed. */
export function filterProblem(f: QueryFilter, rawLimit: string | null): string | null {
    if (f.status && !QUERY_STATUSES.includes(f.status)) return `--status must be one of ${QUERY_STATUSES.join(', ')}.`;
    for (const [flag, v] of [['date', f.date], ['since', f.since], ['until', f.until]] as const) if (v !== undefined && !DAY.test(v)) return `--${flag} must be YYYY-MM-DD.`;
    if (rawLimit !== null && !(/^\d+$/.test(rawLimit) && Number(rawLimit) >= 1 && Number(rawLimit) <= QUERY_MAX_LIMIT)) return `--limit must be a whole number from 1 to ${QUERY_MAX_LIMIT}.`;
    return null;
}

/** Items matching every given filter, newest first, capped at the limit (default 50, never above 200). `total` counts all matches. */
export function queryItems(items: LedgerItem[], f: QueryFilter): QueryResult {
    const limit = Math.min(f.limit ?? QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT);
    const wanted = f.status ?? 'all';
    const wantedModel = f.model ? (canonicalModel(null, f.model) ?? f.model).toLowerCase() : undefined;
    const matches = items.filter((i) => {
        if (f.id && i.id !== f.id) return false;
        if (f.stream && i.stream !== f.stream) return false;
        if (wantedModel && (i.model ?? '').toLowerCase() !== wantedModel) return false;
        const day = dayOf(i);
        if (f.date && day !== f.date) return false;
        if (f.since && !(day && day >= f.since)) return false;
        if (f.until && !(day && day <= f.until)) return false;
        const status = statusOf(i);
        if (wanted === 'all') return true;
        if (wanted === 'open') return isOpen(i);
        if (wanted === 'closed') return Boolean((i as { closedBy?: unknown }).closedBy);
        return status === wanted;
    });
    matches.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
    const rows = matches.slice(0, limit).map((i): QueryRow => ({
        id: i.id ?? '', kind: i.kind ?? '', status: statusOf(i), stream: i.stream ?? null, repo: i.repo ?? null, ticket: i.ticket ?? null, model: i.model ?? null,
        date: dayOf(i) ?? null, text: (i.text ?? '').replace(/\s+/g, ' ').slice(0, TEXT_MAX),
    }));
    return { total: matches.length, shown: rows.length, limit, rows };
}

export const queryLines = (r: QueryResult): string[] => [
    ...r.rows.map((x) => `  ${x.id}  ${x.status.padEnd(8)} ${x.date ?? '?'}  ${x.stream ?? '-'}${x.repo ? `  ${x.repo}` : ''}  ${x.text}`),
    r.total ? `${r.shown} of ${r.total} shown${r.total > r.shown ? ` (raise --limit, up to ${QUERY_MAX_LIMIT}, or narrow the filters)` : ''}` : 'No matching items.',
];
