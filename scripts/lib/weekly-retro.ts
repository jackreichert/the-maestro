/**
 * Weekly retro draft from the ledger: what went stale, what is blocked, what was dropped, and last week's experiment.
 * Pure functions over the ledger rows and folded items; weekly-retro.ts reads the ledger and prints them.
 *
 * Only what the ledger records is derivable here. Reopened tickets, corrections from the user and cost misses live
 * elsewhere (the tracker, memory, the cost measure), so the draft names them as prompts for the reader, not as data.
 *
 * The experiment is a plain note: `journal.ts note "Retro experiment: <what we try this week>"`. The next draft shows
 * the latest one and whether a later `Retro verdict: keep|drop <why>` note settled it.
 */
import { isInFlight, isOpen } from './ledger-core.ts';
import type { LedgerItem, LedgerRow } from './ledger-core.ts';

export const EXPERIMENT = /^\s*retro experiment:\s*(.+)$/i;
export const VERDICT = /^\s*retro verdict:\s*(keep|drop)\b\s*(.*)$/i;

export interface Aged { id: string; stream?: string; text: string; ageDays: number }
export interface Experiment { id: string; text: string; date: string; verdict: 'keep' | 'drop' | null; reason: string }
export interface Retro { from: string; to: string; days: number; done: number; stale: Aged[]; blocked: Aged[]; dropped: Aged[]; experiment: Experiment | null }

const DAY = 86_400_000;
const ms = (ts: unknown): number => (typeof ts === 'string' ? Date.parse(ts) : NaN);

const aged = (i: LedgerItem, now: number): Aged[] => {
    const started = i.queued !== true && i.stateTs ? i.stateTs : i.ts;
    const age = (now - ms(started)) / DAY;
    return Number.isFinite(age) ? [{ id: String(i.id), stream: i.stream, text: String(i.text ?? ''), ageDays: Math.round(Math.max(0, age) * 10) / 10 }] : [];
};

/** The latest experiment note and the first verdict note after it (a verdict before any experiment is ignored). */
export function lastExperiment(entries: LedgerRow[]): Experiment | null {
    const notes = entries.filter((e) => e.kind === 'note' && typeof e.text === 'string').sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const at = notes.map((n) => EXPERIMENT.test(String(n.text))).lastIndexOf(true);
    if (at < 0) return null;
    const exp = notes[at];
    const after = notes.slice(at + 1).map((n) => VERDICT.exec(String(n.text))).find(Boolean);
    return {
        id: String(exp.id), text: EXPERIMENT.exec(String(exp.text))![1].trim(), date: String(exp.date ?? ''),
        verdict: after ? (after[1].toLowerCase() as 'keep' | 'drop') : null, reason: after ? after[2].trim() : '',
    };
}

/** The draft for the `days` ending at `now`. Stale means in flight for `staleDays` or more (default 7). */
export function weeklyRetro(entries: LedgerRow[], items: LedgerItem[], now: Date, days = 7, staleDays = 7): Retro {
    const end = now.getTime();
    const begin = end - days * DAY;
    const within = (ts: unknown): boolean => ms(ts) >= begin && ms(ts) <= end;
    const open = items.filter((i) => isOpen(i) && (i.kind === 'wip' || i.kind === 'blocked'));
    return {
        from: new Date(begin).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), days,
        done: items.filter((i) => i.kind === 'wip' && i.state === 'done' && within(i.closedBy?.ts)).length,
        stale: open.filter((i) => isInFlight(i)).flatMap((i) => aged(i, end)).filter((a) => a.ageDays >= staleDays).sort((a, b) => b.ageDays - a.ageDays),
        blocked: open.filter((i) => i.kind === 'blocked').flatMap((i) => aged(i, end)).sort((a, b) => b.ageDays - a.ageDays),
        dropped: items.filter((i) => i.closedBy && i.state === 'dropped' && within(i.closedBy.ts)).flatMap((i) => aged(i, end)),
        experiment: lastExperiment(entries),
    };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const rows = (list: Aged[], none: string): string[] => (list.length ? list.map((a) => `    ${a.ageDays}d  ${a.id}  ${clip(a.text, 70)}`) : [`    ${none}`]);

/** The draft as plain text: facts first, then the prompts for what the ledger cannot know, then the one-experiment step. */
export function renderRetro(r: Retro): string {
    const e = r.experiment;
    const last = !e ? 'none recorded' : `${e.text} (${e.date}) - ${e.verdict ? `${e.verdict.toUpperCase()}${e.reason ? `: ${e.reason}` : ''}` : 'undecided: keep or drop it'}`;
    return [
        `Retro, ${r.from} to ${r.to} (${r.days} days)`,
        `  last experiment  ${last}`,
        `  done             ${r.done}`,
        '  stale (in flight longer than the cutoff, oldest first)', ...rows(r.stale, 'none'),
        '  blocked', ...rows(r.blocked, 'none'),
        '  dropped this week', ...rows(r.dropped, 'none'),
        '  not in the ledger, add by hand: reopened tickets, corrections from the user, cost misses',
        '  next: pick exactly one experiment, then record it:  journal.ts note "Retro experiment: <what>"',
        '  and settle last one:  journal.ts note "Retro verdict: keep|drop <why>"; keep it as a rule only if it held.',
    ].join('\n');
}
