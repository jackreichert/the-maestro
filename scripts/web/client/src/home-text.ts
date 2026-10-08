/** The words and counts of the stream home base: progress sentences, the Clear line, row notes. Pure and DOM-free so node:test covers it. */
import type { HomeEpic, HomeTicket, StreamHome } from './types.ts';

/** An epic or ticket this many days without a change is called quiet, as a fact about its note. */
export const QUIET_DAYS = 14;
/** How many rows a long group shows before its "Show all". */
export const ROW_CAP = 5;

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** "9 of 14 closed (64%)": the denominator is always in the sentence, including for an epic with no tickets ("0 of 0 closed"). */
export function progressSentence(e: Pick<HomeEpic, 'closed' | 'total'>): string {
  const base = `${e.closed} of ${e.total} closed`;
  return e.total > 0 ? `${base} (${Math.round((e.closed / e.total) * 100)}%)` : base;
}

/** "6 of 14 verified" for an epic that needs verification, else null. */
export function verifiedSentence(e: Pick<HomeEpic, 'verify' | 'total'>): string | null {
  return e.verify.required ? `${e.verify.verified} of ${e.total} verified` : null;
}

/** How an epic ends: `complete` when every ticket is closed (and verified, if required), `unresolved` when closed but not verified. */
export function epicEnd(e: Pick<HomeEpic, 'closed' | 'total' | 'verify'>): 'complete' | 'unresolved' | null {
  if (e.total === 0 || e.closed !== e.total) return null;
  return e.verify.required && e.verify.verified < e.total ? 'unresolved' : 'complete';
}

/** The open counts that are not zero, in the order the page lists them: "2 in progress · 1 blocked · 2 not started". */
export function openCounts(e: Pick<HomeEpic, 'inProgress' | 'blocked' | 'notStarted'>): string {
  return [[e.inProgress, 'in progress'], [e.blocked, 'blocked'], [e.notStarted, 'not started']]
    .filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} ${w as string}`).join(' · ');
}

/** The segments of the status bar, in order, with their counts; zero-width segments are left out. */
export function barSegments(e: Pick<HomeEpic, 'closed' | 'inProgress' | 'blocked' | 'notStarted'>): { key: 'closed' | 'progress' | 'blocked' | 'todo'; n: number }[] {
  return ([['closed', e.closed], ['progress', e.inProgress], ['blocked', e.blocked], ['todo', e.notStarted]] as const)
    .filter(([, n]) => n > 0).map(([key, n]) => ({ key, n }));
}

/** "quiet 21 days" once a note is two weeks old, else null. It states a fact about the file, not about anyone. */
export function quietNote(days: number | null): string | null {
  return days !== null && days >= QUIET_DAYS ? `quiet ${Math.floor(days)} days` : null;
}

/** The small facts after a ticket's title: points, quiet, awaiting you. */
export function ticketNotes(t: Pick<HomeTicket, 'points' | 'quietDays' | 'awaitsYou'>): string[] {
  return [
    ...(t.points !== undefined ? [`${t.points} ${t.points === 1 ? 'pt' : 'pts'}`] : []),
    ...(t.awaitsYou ? ['awaits you'] : []),
    ...(quietNote(t.quietDays) ? [quietNote(t.quietDays) as string] : []),
  ];
}

/** Every open ticket the tab can show, by group, with the count the server left out (`truncated`). */
export interface LeftGroups { inProgress: HomeTicket[]; blocked: HomeTicket[]; notStarted: HomeTicket[]; shown: number; truncated: number }

/** The "What's left" groups. Loose stream tickets that are not already in a group join Not started. */
export function leftGroups(home: Pick<StreamHome, 'left' | 'loose'>): LeftGroups {
  const seen = new Set([...home.left.inProgress, ...home.left.blocked, ...home.left.notStarted].map((t) => t.id));
  const loose = home.loose.filter((t) => !seen.has(t.id));
  const notStarted = [...home.left.notStarted, ...loose];
  const { inProgress, blocked } = home.left;
  return { inProgress, blocked, notStarted, shown: inProgress.length + blocked.length + notStarted.length, truncated: home.left.truncated };
}

/** "What's left (5 of 14)": the open tickets over every ticket the stream's epics hold; just the count when there is no epic to compare to. */
export function leftHeading(g: LeftGroups, epics: Pick<HomeEpic, 'total'>[]): string {
  const total = epics.reduce((n, e) => n + e.total, 0);
  const open = g.shown + g.truncated;
  return total >= open && epics.length > 0 ? `What's left (${open} of ${total})` : `What's left (${open})`;
}

/** The first `cap` rows, and how many are behind "Show all". */
export function capRows<T>(rows: T[], cap = ROW_CAP): { shown: T[]; rest: T[] } {
  return { shown: rows.slice(0, cap), rest: rows.slice(cap) };
}

/** A section that has nothing in it, named for the Clear line ("nothing blocked"). */
export interface ClearPart { phrase: string; empty: boolean }

/** "Clear: nothing blocked, nothing queued." for the empty sections, or null when none is empty. Every empty list shares this one line. */
export function clearLine(parts: ClearPart[]): string | null {
  const empty = parts.filter((p) => p.empty).map((p) => p.phrase);
  return empty.length ? `Clear: ${empty.join(', ')}.` : null;
}

/** The teaching line for a stream with no epic: what to do to get progress shown. */
export function noEpicLine(home: Pick<StreamHome, 'unknowns' | 'epics'>): string {
  const vault = home.unknowns.find((u) => u.kind === 'no-vault');
  if (vault) return vault.text;
  return 'No epic is mapped to this stream yet, so there is no progress to show. Link a ticket to the stream, or name its epics in stream-homes.json.';
}

/** "What we can't tell (2)": the heading of the unknowns disclosure. */
export function unknownsHeading(n: number): string {
  return `What we can't tell (${n})`;
}

/** "2 unknowns" for an epic block's link to the unknowns section; null when there are none. */
export function epicUnknownsLabel(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'unknown')}` : null;
}

/** "1 awaits you" or "2 await you"; null when none. */
export function awaitingLabel(n: number): string | null {
  return n > 0 ? `${n} ${plural(n, 'awaits', 'await')} you` : null;
}
