/**
 * Agent-run quality from the raw ledger rows, for the weekly flow report: how often work was sent back and how many runs wrote nothing.
 *
 *   completed run  an item closed by a `done` row inside the window
 *   retry          a `queue` row naming the item (an in-flight item moved back to queued) before it was done; a row that queues a brand new item is not one
 *   silent run     a `brief` row inside the window whose report file is missing or empty (the agent was briefed and produced nothing)
 *
 *   rework         a `rework` row (`journal.ts log <id> --kind rework`) inside the window: that item's output was edited before use. The rate is completed runs that were reworked over completed runs
 * Pure over rows; the caller supplies `reportSize`, because only the caller touches the file system.
 */
import type { LedgerRow } from './ledger-core.ts';

export interface RunQuality {
    completed: number;
    /** Completed runs that were sent back at least once. */
    retried: number;
    /** All send-backs across completed runs. */
    retries: number;
    /** Send-backs per completed run, one decimal; null with no completed run. */
    retriesPerRun: number | null;
    briefed: number;
    silent: number;
    /** The item ids of the silent runs, at most ten. */
    silentIds: string[];
    /** Rework rows inside the window, and the distinct items they name. */
    reworkRows: number;
    reworked: number;
    /** Completed runs that were reworked, and that share of completed runs as a whole percent; null with no completed run. */
    reworkedCompleted: number;
    reworkPercent: number | null;
}

const DAY = 86_400_000;
const ts = (r: LedgerRow): number => (typeof r.ts === 'string' ? Date.parse(r.ts) : NaN);

export function runQuality(rows: LedgerRow[], now: Date, days: number, reportSize: (path: string) => number | null): RunQuality {
    const end = now.getTime();
    const begin = end - days * DAY;
    const inWindow = (r: LedgerRow): boolean => ts(r) >= begin && ts(r) <= end;
    const done = new Map<string, number>();
    for (const r of rows) if (r.kind === 'done' && r.closes && inWindow(r)) done.set(r.closes, ts(r));
    const sendBacks = new Map<string, number>();
    for (const r of rows) {
        const closedAt = r.queues ? done.get(r.queues) : undefined;
        if (r.kind === 'queue' && r.queues && closedAt !== undefined && ts(r) <= closedAt) sendBacks.set(r.queues, (sendBacks.get(r.queues) ?? 0) + 1);
    }
    const retries = [...sendBacks.values()].reduce((n, c) => n + c, 0);
    const briefs = new Map<string, LedgerRow>();
    for (const r of rows) if (r.kind === 'brief' && r.briefs && inWindow(r)) briefs.set(r.briefs, r);
    const silentIds = [...briefs].filter(([, r]) => !r.report || !(reportSize(r.report) ?? 0)).map(([id]) => id);
    const reworkedIds = new Set<string>();
    let reworkRows = 0;
    for (const r of rows) if (r.kind === 'rework' && r.reworks && inWindow(r)) { reworkRows++; reworkedIds.add(r.reworks); }
    const reworkedCompleted = [...reworkedIds].filter((id) => done.has(id)).length;
    return {
        reworkRows, reworked: reworkedIds.size, reworkedCompleted,
        reworkPercent: done.size ? Math.round((reworkedCompleted / done.size) * 100) : null,
        completed: done.size, retried: sendBacks.size, retries,
        retriesPerRun: done.size ? Math.round((retries / done.size) * 10) / 10 : null,
        briefed: briefs.size, silent: silentIds.length, silentIds: silentIds.slice(0, 10),
    };
}

/** The report lines: counts first, then which runs were silent. */
export function renderRunQuality(q: RunQuality): string[] {
    return [
        '  run quality (agent runs, ledger rows)',
        `    retries      ${q.retries} send-backs over ${q.completed} completed (${q.retriesPerRun === null ? 'n/a' : q.retriesPerRun} per run, ${q.retried} runs retried)`,
        `    silent runs  ${q.silent} of ${q.briefed} briefed wrote no report${q.silentIds.length ? `: ${q.silentIds.join(', ')}` : ''}`,
        `    rework       ${q.reworkedCompleted} of ${q.completed} completed (${q.reworkPercent === null ? 'n/a' : `${q.reworkPercent}%`}); ${q.reworkRows} rework rows on ${q.reworked} items in the window${q.reworkRows ? '' : ' (log one with journal.ts log <id> --kind rework)'}`,
    ];
}
