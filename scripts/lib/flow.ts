/**
 * Flow measures from the folded ledger: cycle time, throughput, work in progress, the age of what is open,
 * and how long open items have been sitting in the stage the ledger can see. Pure functions over LedgerItem[];
 * flow-report.ts reads the ledger and prints them. This is the same fold the rest of the report uses.
 *
 * Definitions (the Kanban Guide's four measures, applied to ledger items):
 *   start       when the item went in flight: the `promote` row for an item that began queued, else the row that opened it
 *   done        the `done` row that closed it (a dropped item never finished, so it is neither throughput nor cycle time)
 *   cycle time  done minus start, for items done inside the window
 *   age         now minus start, for every item still open (queued items age from when they were queued)
 *   WIP         items open and in flight right now; queued items are counted apart
 *
 * Stage dwell (stuck-work review, ledger stages only):
 *   stage       queued, in flight, blocked, or awaiting a person (an open question or pending decision that is not a paste)
 *   entered     when the item entered its current stage: the latest queue move, the in-flight start, or the row that opened a blocked item or an ask
 *   dwell       now minus entered, for items still open in that stage. Time already left behind is not reconstructed: the fold keeps only the latest queue or promote
 *   in window   the part of that dwell that falls inside the report window (7 to 14 days is the weekly review; the caller passes --days, default 14)
 *   longest     the stage of the open item with the greatest current-stage dwell. A tie goes to the lower id
 *   waits on    a gate, a ticket (the gate's ticket, else the row's ticket), or a person, and only when the row already has the field. Otherwise "unrecorded"
 */
import { parseGate } from './boxes.ts';
import { isInFlight, isOpen, isPendingDecision, isQueued } from './ledger-core.ts';
import type { LedgerItem, LedgerRow } from './ledger-core.ts';

export interface FlowItem { id: string; stream?: string; text: string; startedAt: string; ageDays: number; queued: boolean }

/** Stages the ledger itself can see. Pull-request stages are not among them. */
export const LEDGER_STAGES = ['queued', 'in flight', 'blocked', 'awaiting a person'] as const;
export type LedgerStage = (typeof LEDGER_STAGES)[number];

export interface StageDwellRow {
    stage: LedgerStage;
    /** Sum of current-stage time that falls inside the window, in days. */
    dwellDays: number;
    items: number;
    /** Longest current-stage age in this stage, in days. Null when the stage has no usable timestamp. */
    longestDays: number | null;
}

export interface WaitingItem {
    id: string;
    stream?: string;
    text: string;
    stage: LedgerStage;
    /** Full age in the current stage, in days. Not clipped to the window. */
    ageDays: number;
    /** What the row already names. The literal `unrecorded` when it names nothing. */
    waitsOn: string;
}

export interface StageDwellView {
    stages: StageDwellRow[];
    /** Stage of the longest-waiting open item. Null when no staged item has a usable timestamp. */
    longest: LedgerStage | null;
    longestDays: number | null;
    /** At most five open items, longest current-stage age first. */
    waiting: WaitingItem[];
}

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
    /** Every open work item, oldest first. */
    open: FlowItem[];
    /** Where open items are waiting, from the same folded rows. */
    dwell: StageDwellView;
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

const recorded = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * What the row already says it waits on, first match: a gate (a `ticket:` gate is that ticket), the row's
 * ticket, or `person`. Prose is never read, and a question does not imply a person the row did not name.
 */
export function waitsOn(item: LedgerRow): string {
    const gate = recorded(item.gate);
    if (gate) {
        const parsed = parseGate(gate);
        if (parsed?.type === 'ticket') return `ticket: ${parsed.id}`;
        return `gate: ${gate}`;
    }
    const ticket = recorded(item.ticket);
    if (ticket) return `ticket: ${ticket}`;
    const person = recorded(item.person);
    if (person) return `person: ${person}`;
    return 'unrecorded';
}

/** The ledger stage an open item is in now, or null when the ledger has no stage for it (closed, paste, or another kind). */
export function ledgerStage(item: LedgerItem): LedgerStage | null {
    if (!isOpen(item)) return null;
    if (isQueued(item)) return 'queued';
    if (isInFlight(item)) return 'in flight';
    if (item.kind === 'blocked') return 'blocked';
    if ((item.kind === 'question' || isPendingDecision(item)) && !item.paste) return 'awaiting a person';
    return null;
}

/** When the item entered its current stage. A missing or future timestamp is left for the caller to skip. */
function enteredAt(item: LedgerItem, stage: LedgerStage): string | undefined {
    if (stage === 'queued') return item.stateTs ?? item.ts;
    if (stage === 'in flight') return startOf(item);
    return item.ts;
}

const TOP_WAITING = 5;

/** Stage dwell for open items at `now`, over the same `days` window as the rest of the report. */
export function stageDwell(items: LedgerItem[], now: Date, days: number): StageDwellView {
    const end = now.getTime();
    const begin = end - days * DAY;
    const rows = items.flatMap((item) => {
        const stage = ledgerStage(item);
        if (!stage) return [];
        const entered = ms(enteredAt(item, stage));
        if (!Number.isFinite(entered) || entered > end) return [];
        const age = (end - entered) / DAY;
        if (!Number.isFinite(age) || age < 0) return [];
        return [{
            id: String(item.id), stream: item.stream, text: String(item.text ?? ''), stage, age,
            windowDays: Math.max(0, (end - Math.max(entered, begin)) / DAY), waitsOn: waitsOn(item),
        }];
    });
    const stages: StageDwellRow[] = LEDGER_STAGES.map((stage) => {
        const inStage = rows.filter((r) => r.stage === stage);
        return {
            stage,
            dwellDays: round3(inStage.reduce((n, r) => n + r.windowDays, 0)),
            items: inStage.length,
            longestDays: inStage.length ? round3(Math.max(...inStage.map((r) => r.age))) : null,
        };
    });
    const ranked = [...rows].sort((a, b) => b.age - a.age || a.id.localeCompare(b.id));
    const top = ranked[0];
    return {
        stages,
        longest: top?.stage ?? null,
        longestDays: top ? round3(top.age) : null,
        waiting: ranked.slice(0, TOP_WAITING).map((r) => ({
            id: r.id, ...(r.stream ? { stream: r.stream } : {}), text: r.text, stage: r.stage, ageDays: round3(r.age), waitsOn: r.waitsOn,
        })),
    };
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
        dwell: stageDwell(items, now, days),
    };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** The report as plain text. `oldest` caps how many open work items are listed (all of them by default). */
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
    lines.push('  stage dwell (ledger stages, open items)');
    for (const s of r.dwell.stages) lines.push(`    ${s.stage.padEnd(18)}  ${formatSpan(s.dwellDays).padStart(6)} in window  ${s.items}  longest ${fmt(s.longestDays)}`);
    lines.push(r.dwell.longest === null ? '  longest dwell  none' : `  longest dwell  ${r.dwell.longest}  ${fmt(r.dwell.longestDays)}`);
    lines.push('  longest-waiting (top 5)');
    if (!r.dwell.waiting.length) lines.push('    none');
    for (const w of r.dwell.waiting) lines.push(`    ${formatSpan(w.ageDays).padStart(6)}  ${w.stage.padEnd(18)}  ${w.id}  ${w.waitsOn}  ${clip(w.text, 50)}`);
    return lines.join('\n');
}
