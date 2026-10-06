/**
 * The Podium web app's chart data: pure reducers over folded ledger items and open PRs.
 * No file, clock, environment or process access: the caller passes `now` and the time zone, so a request handler can call
 * these on every refresh and a test can call them with a fixed clock. Days are the page's days (the zone `tz`), never the
 * ledger's UTC `date` field, so an evening's work lands on the day the Podium shows.
 */
import type { LedgerItem } from '../ledger-core.ts';
import type { Pr } from '../status-page/render.ts';
import { localDate } from '../status-page/priorities.ts';
import { family } from '../model-family.ts';

const OTHER = 'other';
const DAY_MS = 86_400_000;

export interface ThroughputDay { date: string; total: number; byStream: Record<string, number> }
export interface AgeBucket { label: string; count: number; ids: string[] }
export interface PrMix {
  byState: Record<string, number>;
  byStream: Record<string, Record<string, number>>;
  /** The four counts the Markdown page's Open PRs line prints. */
  totals: { open: number; draft: number; conflicting: number; withThreads: number; failingCi: number };
}
export interface ModelMix { byFamily: Record<string, number>; source: 'ledger' }
export interface Charts { days: string[]; throughput: ThroughputDay[]; ageBuckets: AgeBucket[]; prMix: PrMix; modelMix: ModelMix }

export interface ChartsInput { items: LedgerItem[]; awaiting: LedgerItem[]; prs: Pr[]; now: Date; tz: string; days: number }

/** All four charts for the last `days` page days ending today. */
export function buildCharts(input: ChartsInput): Charts {
  const { items, awaiting, prs, now, tz, days } = input;
  return {
    days: lastDays(now, tz, days),
    throughput: throughputByDay(items, days, tz, now),
    ageBuckets: awaitingAge(awaiting, now, tz),
    prMix: prMix(prs),
    modelMix: modelMix(items, days, tz, now),
  };
}

/** `n` page dates ending at today's, oldest first. Calendar arithmetic on the date, so a daylight-saving change never skips or repeats a day. */
export function lastDays(now: Date, tz: string, n: number): string[] {
  const [y = 0, m = 1, d = 1] = localDate(now, tz).split('-').map(Number);
  return Array.from({ length: Math.max(0, n) }, (_, i) => new Date(Date.UTC(y, m - 1, d - (n - 1 - i))).toISOString().slice(0, 10));
}

/** When the item was finished: its closing row's time for an item closed `done`, its own time for one that was written done. Undefined for anything else or an unreadable time. */
function finishedAt(i: LedgerItem): string | undefined {
  const ts = i.closedBy ? (i.closedBy.kind === 'done' ? i.closedBy.ts : undefined) : (i.state === 'done' ? i.ts : undefined);
  return ts !== undefined && Number.isFinite(Date.parse(ts)) ? ts : undefined;
}

/** The items finished on each of the last `days` page days, with the stream of each one. */
function finishedInWindow(items: LedgerItem[], days: number, tz: string, now: Date): Map<string, LedgerItem[]> {
  const byDay = new Map(lastDays(now, tz, days).map((d): [string, LedgerItem[]] => [d, []]));
  for (const i of items) {
    const ts = finishedAt(i);
    if (ts !== undefined) byDay.get(localDate(new Date(ts), tz))?.push(i);
  }
  return byDay;
}

/** Counts per key. A Map while counting, so a key such as `__proto__` is just a key; `toRecord` copies it out as own properties. */
type Tally = Map<string, number>;
const bump = (counts: Tally, key: string): void => { counts.set(key, (counts.get(key) ?? 0) + 1); };
const toRecord = (counts: Tally): Record<string, number> => Object.fromEntries(counts);

/** Items finished per page day, zero-filled, split by stream (`other` when an item has none). */
export function throughputByDay(items: LedgerItem[], days: number, tz: string, now: Date): ThroughputDay[] {
  return [...finishedInWindow(items, days, tz, now)].map(([date, done]) => {
    const byStream: Tally = new Map();
    for (const i of done) bump(byStream, i.stream ?? OTHER);
    return { date, total: done.length, byStream: toRecord(byStream) };
  });
}

const AGE_BUCKETS: { label: string; below: number }[] = [
  { label: 'under 1 d', below: 1 }, { label: '1-3 d', below: 3 }, { label: '3-7 d', below: 7 }, { label: 'over 7 d', below: Infinity },
];

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

/** Open asks by whole days waited (`askAgeDays`): under 1 d, 1-3 d, 3-7 d, over 7 d. An ask with no readable time counts as brand new. */
export function awaitingAge(awaiting: LedgerItem[], now: Date, tz: string): AgeBucket[] {
  const buckets: AgeBucket[] = AGE_BUCKETS.map((b) => ({ label: b.label, count: 0, ids: [] }));
  for (const a of awaiting) {
    const age = askAgeDays(a, now, tz);
    const bucket = buckets[AGE_BUCKETS.findIndex((b) => age < b.below)];
    if (bucket) { bucket.count += 1; if (a.id) bucket.ids.push(a.id); }
  }
  return buckets;
}

const CI_STATE = new Map([['SUCCESS', 'pass'], ['FAILURE', 'fail'], ['ERROR', 'fail'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['NONE', 'none']]);

/** Open PRs by CI state, overall and per stream, with the counts the Markdown page prints (draft, conflicting, with threads, failing CI). */
export function prMix(prs: Pr[]): PrMix {
  const byState: Tally = new Map();
  const byStream = new Map<string, Tally>();
  const totals = { open: prs.length, draft: 0, conflicting: 0, withThreads: 0, failingCi: 0 };
  for (const p of prs) {
    const state = CI_STATE.get(p.ci) ?? p.ci.toLowerCase();
    bump(byState, state);
    if (!byStream.has(p.stream)) byStream.set(p.stream, new Map());
    bump(byStream.get(p.stream)!, state);
    if (p.isDraft) totals.draft += 1;
    if (p.mergeable === 'CONFLICTING') totals.conflicting += 1;
    if (p.unresolved > 0) totals.withThreads += 1;
    if (state === 'fail') totals.failingCi += 1;
  }
  return { byState: toRecord(byState), byStream: Object.fromEntries([...byStream].map(([s, t]) => [s, toRecord(t)])), totals };
}

/** Items finished in the window by model family (opus, sonnet, haiku, fable, other). A count of items, not of tokens. */
export function modelMix(items: LedgerItem[], days: number, tz: string, now: Date): ModelMix {
  const byFamily: Tally = new Map();
  for (const done of finishedInWindow(items, days, tz, now).values()) for (const i of done) bump(byFamily, family(i.model));
  return { byFamily: toRecord(byFamily), source: 'ledger' };
}
