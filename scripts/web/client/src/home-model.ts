/** What the Home tab shows, worked out from the state, charts and projects payloads. Pure and DOM-free: home-tab only draws it. */
import type { ChartData } from './chart-math.ts';
import { oldestFirst } from './glance.ts';
import type { ChartDoneItem, ChartsData, EpicLine, EpicsData, PodiumState, ProjectRow, ProjectsData } from './types.ts';

const DAY_MS = 86_400_000;
/** The age buckets the server uses for asks (charts.ts), so the two series on the age chart line up. */
export const AGE_LABELS = ['under 1 d', '1-3 d', '3-7 d', 'over 7 d'] as const;
const AGE_BELOW = [1, 3, 7, Number.POSITIVE_INFINITY];

const bucketOf = (days: number): number => AGE_BELOW.findIndex((b) => days < b);

/** Open asks and open work (in flight or blocked) per age bucket, as one stacked chart. Work with no readable start is left out and counted. */
export function ageChart(st: PodiumState): { data: ChartData; undated: number } {
  const asks = AGE_LABELS.map(() => 0);
  const work = AGE_LABELS.map(() => 0);
  let undated = 0;
  for (const a of st.asks) asks[bucketOf(a.ageDays)] += 1;
  const now = Date.parse(st.generatedAt);
  for (const w of [...st.working, ...st.blocked]) {
    const since = Date.parse(w.since);
    if (!Number.isFinite(since) || !Number.isFinite(now)) { undated += 1; continue; }
    work[bucketOf(Math.max(0, (now - since) / DAY_MS))] += 1;
  }
  return { data: { labels: [...AGE_LABELS], series: [{ name: 'Asks', values: asks }, { name: 'In flight or blocked', values: work }] }, undated };
}

/** Done per seven-day period, one series per stream in the page's stream order, labelled by each period's first day. */
export function weeksChart(p: ProjectsData, order: string[]): ChartData {
  const rank = (s: string): number => { const i = order.indexOf(s); return i === -1 ? order.length : i; };
  const streams = [...new Set(p.weeks.flatMap((w) => Object.keys(w.byStream)))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { labels: p.weeks.map((w) => w.start.slice(5)), series: streams.map((name) => ({ name, values: p.weeks.map((w) => w.byStream[name] ?? 0) })) };
}

/** `n` is the stream's count from the per-day totals; `items` are the ones the capped item list still holds, so it may be shorter. */
export interface DoneGroup { stream: string; n: number; items: ChartDoneItem[] }
export interface DoneSpan { n: number; groups: DoneGroup[] }
/** What we got done: today, and the seven page days ending today. `missing` counts ids the server's capped item list no longer holds. */
export interface Done { today: DoneSpan; week: DoneSpan; missing: number }

export function doneSpans(c: ChartsData, order: string[]): Done {
  const byId = new Map(c.doneItems.map((i) => [i.id, i]));
  let missing = 0;
  const span = (days: ChartsData['throughput']): DoneSpan => {
    const ids = days.flatMap((d) => d.ids);
    const items = ids.flatMap((id) => { const it = byId.get(id); if (!it) missing += 1; return it ? [it] : []; });
    const counts: Record<string, number> = {};
    for (const d of days) for (const [s, n] of Object.entries(d.byStream)) counts[s] = (counts[s] ?? 0) + n;
    const streams = Object.keys(counts).filter((s) => counts[s]! > 0).sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9) || a.localeCompare(b));
    return { n: ids.length, groups: streams.map((stream) => ({ stream, n: counts[stream]!, items: items.filter((i) => i.stream === stream) })) };
  };
  const today = span(c.throughput.slice(-1));
  missing = 0;   // count once, over the week, which includes today
  return { today, week: span(c.throughput.slice(-7)), missing };
}

/** A row's facts as short phrases, each a count with its noun; zero counts are left out so the row reads what is there. */
export function rowFacts(r: ProjectRow): string[] {
  const n = (count: number, one: string, many: string): string | null => (count > 0 ? `${count} ${count === 1 ? one : many}` : null);
  return [
    n(r.asks, 'ask', 'asks'), n(r.inflight, 'in flight', 'in flight'), n(r.blocked, 'blocked', 'blocked'), n(r.prs, 'open PR', 'open PRs'),
    r.oldestOpenDays !== null ? `oldest open ${r.oldestOpenDays < 1 ? 'under 1 d' : `${r.oldestOpenDays} d`}` : null,
    r.shippedWeek > 0 ? `${r.shippedWeek} shipped this week` : r.lastShipped ? `last shipped ${r.lastShipped.slice(5)}` : 'nothing shipped in 8 weeks',
  ].filter((x): x is string => x !== null);
}

/** The order rows are read in: what needs the reader, then blocked, then moving, then quiet; ties keep today's priority rank, then the page order. */
const STATE_ORDER: ProjectRow['state'][] = ['waiting on you', 'blocked', 'moving', 'quiet'];
export function rowOrder(rows: ProjectRow[]): ProjectRow[] {
  const rank = (r: ProjectRow): number => r.rank ?? Number.POSITIVE_INFINITY;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => STATE_ORDER.indexOf(a.r.state) - STATE_ORDER.indexOf(b.r.state) || rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** The status glyph token for a state word: a status colour always travels with its symbol and its word. */
export const STATE_TONE: Record<ProjectRow['state'], 'attention' | 'critical' | 'success' | 'quiet'> = {
  'waiting on you': 'attention', blocked: 'critical', moving: 'success', quiet: 'quiet',
};

/** One day column of the score table: a letter for most days, a date at the start of each week, and a bar before a new week. */
export interface ScoreDay { date: string; label: string; weekStart: boolean; today: boolean }
/** One stream's line of the score table: a note per day (pitch 0 is a rest), its open counts and its state word. */
export interface ScoreRow {
  stream: string; projects: string[]; days: number[]; pitches: number[];
  asks: number; queued: number; prs: number; total: number; state: ProjectRow['state'];
}
export interface Score { days: ScoreDay[]; rows: ScoreRow[] }

const dateLabel = (day: string): string => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${day}T12:00:00Z`));
const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();
const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The state word for a stream from its own counts, used when the server's project rows have not arrived or do not list it. */
export function streamState(asks: number, blocked: number, working: number, shipped: number): ProjectRow['state'] {
  return asks > 0 ? 'waiting on you' : blocked > 0 ? 'blocked' : working > 0 || shipped > 0 ? 'moving' : 'quiet';
}

/**
 * The last 14 chart days for every stream, as a score: each day's note is a pitch from 0 (a rest) to 4, on a log scale
 * so one busy day does not flatten the rest. Counts come from the state; project names and state words from the project
 * rows when they are loaded.
 */
export function scoreTable(st: PodiumState, charts: ChartsData, projects: ProjectsData | null): Score {
  const days = charts.days.slice(-14);
  const byDate = new Map(charts.throughput.map((t) => [t.date, t.byStream]));
  const count = (stream: string, day: string): number => byDate.get(day)?.[stream] ?? 0;
  const max = Math.max(1, ...st.streams.flatMap((s) => days.map((d) => count(s, d))));
  const pitch = (n: number): number => (n <= 0 ? 0 : Math.max(1, Math.round((Math.log1p(n) / Math.log1p(max)) * 4)));
  const of = <T extends { stream: string }>(xs: T[], s: string): number => xs.filter((x) => x.stream === s).length;
  const info = new Map((projects?.rows ?? []).map((r) => [r.stream, r]));
  return {
    days: days.map((date, i) => ({ date, label: i === 0 || weekdayOf(date) === 1 ? dateLabel(date) : WEEKDAY_LETTER[weekdayOf(date)] ?? '', weekStart: i > 0 && weekdayOf(date) === 1, today: i === days.length - 1 && date === st.today })),
    rows: st.streams.map((stream) => {
      const counts = days.map((d) => count(stream, d));
      const known = info.get(stream);
      return {
        stream, projects: known?.projects ?? [], days: counts, pitches: counts.map(pitch),
        asks: of(st.asks, stream), queued: of(st.queued, stream), prs: of(st.prs, stream), total: counts.reduce((a, b) => a + b, 0),
        state: known?.state ?? streamState(of(st.asks, stream), of(st.blocked, stream), of(st.working, stream), of(st.done, stream)),
      };
    }),
  };
}

export type AskOrder = 'oldest' | 'oneway';
/** Asks in the order the reader picked: oldest first, or one-way doors first (oldest first inside each group). */
export function orderAsks<T extends { ageDays: number; ts: string; door?: string }>(asks: T[], order: AskOrder): T[] {
  const rank = (a: T): number => (order === 'oneway' && a.door !== 'one-way' ? 1 : 0);
  return oldestFirst(asks).map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}

/** Open asks per age bucket (the same four labels the server uses), with the last two flagged as past the stale mark. */
export function askAgeBars(asks: { ageDays: number }[]): { label: string; n: number; stale: boolean }[] {
  const n = AGE_LABELS.map(() => 0);
  for (const a of asks) n[bucketOf(a.ageDays)] += 1;
  return AGE_LABELS.map((label, i) => ({ label, n: n[i] ?? 0, stale: i >= 2 }));
}

export type CiKey = 'pass' | 'pending' | 'fail' | 'none';
const CI_KEY: Record<string, CiKey> = { SUCCESS: 'pass', PASS: 'pass', FAILURE: 'fail', ERROR: 'fail', FAIL: 'fail', PENDING: 'pending', EXPECTED: 'pending' };
/** Open PRs by CI state, and the three counts that say where they are stuck. Case does not matter: the live server and the fixtures spell states differently. */
export function prGauge(prs: PodiumState['prs'], charts: ChartsData | null): { total: number; ci: Record<CiKey, number>; queue: { count: number; cap: number } | null; threads: number; conflicting: number } {
  const ci: Record<CiKey, number> = { pass: 0, pending: 0, fail: 0, none: 0 };
  for (const p of prs) ci[CI_KEY[p.ci.toUpperCase()] ?? 'none'] += 1;
  const q = charts?.reviewQueue;
  return {
    total: prs.length, ci,
    queue: q && 'count' in q ? { count: q.count, cap: q.cap } : null,
    threads: prs.filter((p) => p.unresolved > 0).length,
    conflicting: prs.filter((p) => p.mergeable === 'CONFLICTING').length,
  };
}

/** An epic as a card: its stream, ticket counts as bar segments in reading order, and the next ticket to pick up. */
export interface EpicCard { stream: string; line: EpicLine; segments: { key: 'closed' | 'progress' | 'blocked' | 'open'; n: number }[] }
export function epicCards(e: EpicsData | null): EpicCard[] {
  if (!e) return [];
  return [...e.streams.flatMap((g) => g.epics.map((line) => ({ stream: g.stream, line }))), ...e.unfiled.map((line) => ({ stream: 'unfiled', line }))].map(({ stream, line }) => ({
    stream, line,
    segments: [{ key: 'closed' as const, n: line.closed }, { key: 'progress' as const, n: line.inProgress }, { key: 'blocked' as const, n: line.blocked }, { key: 'open' as const, n: line.notStarted }],
  }));
}

/** Queued items per stream, most first, for the In flight panel's bar and list. */
export function queuedByStream(queued: { stream: string }[], order: string[]): { stream: string; n: number }[] {
  const m = new Map<string, number>();
  for (const q of queued) m.set(q.stream, (m.get(q.stream) ?? 0) + 1);
  const rank = (s: string): number => { const i = order.indexOf(s); return i === -1 ? order.length : i; };
  return [...m].map(([stream, n]) => ({ stream, n })).sort((a, b) => b.n - a.n || rank(a.stream) - rank(b.stream));
}
