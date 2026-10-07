/**
 * Flow measures from the folded ledger: cycle time, throughput, work in progress and the age of what is open.
 * Pure functions over LedgerItem[]; flow-report.ts reads the ledger and prints them.
 *
 * Definitions (the Kanban Guide's four measures, applied to ledger items):
 *   start       when the item went in flight: the `promote` row for an item that began queued, else the row that opened it
 *   done        the `done` row that closed it (a dropped item never finished, so it is neither throughput nor cycle time)
 *   cycle time  done minus start, for items done inside the window
 *   age         now minus start, for every item still open (queued items age from when they were queued)
 *   WIP         items open and in flight right now; queued items are counted apart
 */
import { isInFlight, isOpen, isQueued } from './ledger-core.ts';
import type { LedgerItem } from './ledger-core.ts';

export interface FlowItem { id: string; stream?: string; text: string; startedAt: string; ageDays: number; queued: boolean }
export interface FlowReport {
    from: string;
    to: string;
    days: number;
    done: number;
    dropped: number;
    /** Items done per week over the window. */
    perWeek: number;
    /** Start-to-done in days (fractions allowed); null when nothing finished in the window. */
    cycleP50: number | null;
    cycleP85: number | null;
    wip: number;
    queued: number;
    /** Every open item, oldest first. */
    open: FlowItem[];
}

const DAY = 86_400_000;

/** Nearest-rank percentile of a list of numbers (p in 0..100); null for an empty list. */
export function percentile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const ms = (ts: unknown): number => (typeof ts === 'string' ? Date.parse(ts) : NaN);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A span in days as the shortest honest unit: most items finish within hours, so `0d` would hide the whole distribution. */
export function formatSpan(days: number): string {
    const minutes = days * 1440;
    if (minutes < 60) return `${Math.round(minutes)}m`;
    if (minutes < 2880) return `${round1(minutes / 60)}h`;
    return `${round1(days)}d`;
}

/** When an item went in flight: its last `promote` time if it ever sat queued, else the row that opened it. */
export function startOf(item: LedgerItem): string | undefined {
    if (item.queued !== true && item.stateTs) return item.stateTs;
    return item.ts;
}

/** The report for the `days` ending at `now`. Items with no usable timestamp are skipped, not guessed. */
export function flowReport(items: LedgerItem[], now: Date, days = 14): FlowReport {
    const end = now.getTime();
    const begin = end - days * DAY;
    const wipRows = items.filter((i) => i.kind === 'wip');
    const finished = wipRows.filter((i) => i.closedBy && i.state === 'done' && ms(i.closedBy.ts) >= begin && ms(i.closedBy.ts) <= end);
    const cycles = finished.flatMap((i) => {
        const span = (ms(i.closedBy?.ts) - ms(startOf(i))) / DAY;
        return Number.isFinite(span) && span >= 0 ? [span] : [];
    });
    const open = items.filter((i) => isOpen(i) && i.kind === 'wip').flatMap((i): FlowItem[] => {
        const started = startOf(i);
        const age = (end - ms(started)) / DAY;
        if (!started || !Number.isFinite(age)) return [];
        return [{ id: String(i.id), stream: i.stream, text: String(i.text ?? ''), startedAt: started, ageDays: round1(Math.max(0, age)), queued: isQueued(i) }];
    }).sort((a, b) => b.ageDays - a.ageDays);
    const p50 = percentile(cycles, 50);
    const p85 = percentile(cycles, 85);
    return {
        from: new Date(begin).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), days,
        done: finished.length,
        dropped: wipRows.filter((i) => i.closedBy && i.state === 'dropped' && ms(i.closedBy.ts) >= begin && ms(i.closedBy.ts) <= end).length,
        perWeek: round1(finished.length / (days / 7)),
        cycleP50: p50 === null ? null : round3(p50), cycleP85: p85 === null ? null : round3(p85),
        wip: wipRows.filter((i) => isInFlight(i)).length, queued: wipRows.filter((i) => isQueued(i)).length, open,
    };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** The report as the plain text Friday's roll prints. `oldest` caps how many open items are listed (all of them by default). */
export function renderFlow(r: FlowReport, oldest = Infinity): string {
    const fmt = (v: number | null): string => (v === null ? 'n/a' : formatSpan(v));
    const lines = [
        `Flow, ${r.from} to ${r.to} (${r.days} days)`,
        `  throughput  ${r.done} done (${r.perWeek}/week), ${r.dropped} dropped`,
        `  cycle time  p50 ${fmt(r.cycleP50)}, p85 ${fmt(r.cycleP85)}  (start to done)`,
        `  WIP         ${r.wip} in flight, ${r.queued} queued`,
        `  open, oldest first (age from start)`,
    ];
    const shown = r.open.slice(0, oldest);
    for (const i of shown) lines.push(`    ${formatSpan(i.ageDays).padStart(6)}  ${i.queued ? 'queued   ' : 'in flight'}  ${i.id}  ${clip(i.text, 70)}`);
    if (shown.length < r.open.length) lines.push(`    ... ${r.open.length - shown.length} more`);
    if (!r.open.length) lines.push('    none');
    return lines.join('\n');
}
