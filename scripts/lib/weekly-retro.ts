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
/** Tasks finished two or more times in the window, grouped by what they were (the first words of their text). */
export interface Repeated { key: string; ids: string[] }
/** Library misses logged inside the window: how many were answered with a page, closed as out of scope, or are still open (a miss still open now counts as open even if it was closed later than the window ends). */
export interface MissCount { logged: number; answered: number; outOfScope: number; open: number }
export interface Retro { from: string; to: string; days: number; done: number; misses: MissCount; stale: Aged[]; blocked: Aged[]; dropped: Aged[]; repeated: Repeated[]; experiment: Experiment | null }

const DAY = 86_400_000;
const ms = (ts: unknown): number => (typeof ts === 'string' ? Date.parse(ts) : NaN);

const aged = (i: LedgerItem, now: number): Aged[] => {
    const started = i.queued !== true && i.stateTs ? i.stateTs : i.ts;
    const age = (now - ms(started)) / DAY;
    return Number.isFinite(age) ? [{ id: String(i.id), stream: i.stream, text: String(i.text ?? ''), ageDays: Math.round(Math.max(0, age) * 10) / 10 }] : [];
};

const FILLER = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'run', 'make', 'add', 'fix', 'update', 'check', 'again', 'new']);
const KEY_WORDS = 3;

/** What a task was, from its text: its first three plain words, with ids, numbers and PR refs dropped. Null when fewer than two words are left (too little to call two items the same task). */
export function taskKey(text: string): string | null {
    const words = text.toLowerCase().split(/\s+/).filter((w) => /^[a-z][a-z-]{2,}$/.test(w) && !FILLER.has(w)).slice(0, KEY_WORDS);
    return words.length >= 2 ? words.join(' ') : null;
}

/** The finished work items in `items` (closed inside the window) that share a task key, two or more per key, most repeated first. */
export function repeatedTasks(items: LedgerItem[], within: (ts: unknown) => boolean): Repeated[] {
    const groups = new Map<string, string[]>();
    for (const i of items) {
        if (i.kind !== 'wip' || i.state !== 'done' || !within(i.closedBy?.ts)) continue;
        const key = taskKey(String(i.text ?? ''));
        if (key) groups.set(key, [...(groups.get(key) ?? []), String(i.id)]);
    }
    return [...groups].filter(([, ids]) => ids.length >= 2).map(([key, ids]) => ({ key, ids })).sort((a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key));
}

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
/** The misses logged in the window and what became of each: a curated row with a page answered it, one with a reason closed it as out of scope. */
export function missCount(entries: LedgerRow[], within: (ts: unknown) => boolean): MissCount {
    const closers = new Map(entries.filter((r) => r.kind === 'curated' && typeof r.closes === 'string').map((r) => [r.closes as string, r]));
    const logged = entries.filter((r) => r.kind === 'miss' && within(r.ts));
    const closedBy = (r: LedgerRow): LedgerRow | undefined => closers.get(String(r.id));
    return {
        logged: logged.length,
        answered: logged.filter((r) => typeof closedBy(r)?.page === 'string').length,
        outOfScope: logged.filter((r) => typeof closedBy(r)?.rejected === 'string').length,
        open: logged.filter((r) => !closedBy(r)).length,
    };
}

export function weeklyRetro(entries: LedgerRow[], items: LedgerItem[], now: Date, days = 7, staleDays = 7): Retro {
    const end = now.getTime();
    const begin = end - days * DAY;
    const within = (ts: unknown): boolean => ms(ts) >= begin && ms(ts) <= end;
    const open = items.filter((i) => isOpen(i) && (i.kind === 'wip' || i.kind === 'blocked'));
    return {
        from: new Date(begin).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), days,
        done: items.filter((i) => i.kind === 'wip' && i.state === 'done' && within(i.closedBy?.ts)).length,
        misses: missCount(entries, within),
        stale: open.filter((i) => isInFlight(i)).flatMap((i) => aged(i, end)).filter((a) => a.ageDays >= staleDays).sort((a, b) => b.ageDays - a.ageDays),
        blocked: open.filter((i) => i.kind === 'blocked').flatMap((i) => aged(i, end)).sort((a, b) => b.ageDays - a.ageDays),
        dropped: items.filter((i) => i.closedBy && i.state === 'dropped' && within(i.closedBy.ts)).flatMap((i) => aged(i, end)),
        repeated: repeatedTasks(items, within),
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
        `  library misses   ${r.misses.logged} logged, ${r.misses.answered} answered with a page, ${r.misses.outOfScope} out of scope, ${r.misses.open} open`,
        '  stale (in flight longer than the cutoff, oldest first)', ...rows(r.stale, 'none'),
        '  blocked', ...rows(r.blocked, 'none'),
        '  dropped this week', ...rows(r.dropped, 'none'),
        '  done more than once (could each have been Haiku + a script + a runbook? a yes becomes a ticket to build the script and playbook)',
        ...(r.repeated.length ? r.repeated.map((x) => `    ${x.ids.length}x  ${x.key}  (${x.ids.join(', ')})`) : ['    none']),
        '  not in the ledger, add by hand: reopened tickets, corrections from the user, cost misses',
        '  next: pick exactly one experiment, then record it:  journal.ts note "Retro experiment: <what>"',
        '  and settle last one:  journal.ts note "Retro verdict: keep|drop <why>"; keep it as a rule only if it held.',
    ].join('\n');
}
