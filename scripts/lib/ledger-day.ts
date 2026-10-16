/**
 * The ledger's two notions of "a day", in one place so they cannot drift apart again (MAESTRO-184).
 *
 * - `ledgerDay`: the UTC day every row is stamped with (`date`). Anything that measures an age from a stamp (queue age, the stale
 *   in-flight count, the age of an ask) must count to this day too: counting to a local day is one short from UTC midnight until
 *   local midnight.
 * - `userDay`: the calendar day in the user's zone (`watch_tz`). A date the user types or reads as a calendar date (`defer --until`)
 *   means this day, so a deferral typed at 9 pm New York time for "tomorrow" is accepted and lapses at midnight where the user lives.
 *
 * - `askAgeDays`: an ask carries a real time, so its age is whole days in the page zone (the web card, the age chart and the markdown page share it).
 *
 * `MAESTRO_NOW` (an ISO time) pins the clock for both, for tests. Unset or unreadable: the real clock.
 */
import { localDate } from './status-page/priorities.ts';

/** The current time: `MAESTRO_NOW` when it parses, else the real clock. */
export function clock(env: Record<string, string | undefined> = process.env): Date {
  const pinned = env.MAESTRO_NOW ? new Date(env.MAESTRO_NOW) : null;
  return pinned && !Number.isNaN(pinned.getTime()) ? pinned : new Date();
}

/** The UTC day (`YYYY-MM-DD`) rows are stamped with, at `now`. */
export const ledgerDay = (now: Date = clock()): string => now.toISOString().slice(0, 10);

/** The calendar day in `tz` (the system zone when empty) at `now`. */
export const userDay = (tz = '', now: Date = clock()): string => localDate(now, tz);

const DAY_MS = 86_400_000;

/**
 * Whole page days an ask has waited: today's page date minus the ask's page date, never negative. The ask's day is its time `ts`
 * in `tz` (the ledger `date` is a UTC day, so an evening ask would otherwise be a day in the future), else its `date`. The ask
 * card and the age chart both use this, so they cannot disagree.
 */
export function askAgeDays(a: { ts?: string; date?: string }, now: Date, tz: string): number {
  const day = a.ts !== undefined && Number.isFinite(Date.parse(a.ts)) ? localDate(new Date(a.ts), tz) : a.date;
  const since = Date.parse(day ?? '');
  return Number.isFinite(since) ? Math.max(0, Math.round((Date.parse(localDate(now, tz)) - since) / DAY_MS)) : 0;
}
