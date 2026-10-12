/** What the Home tab shows, worked out from the state, charts and projects payloads. Pure and DOM-free: home-tab only draws it. */
import { formatFragment, streamTabId } from './tabs.ts';
import type { ChartData } from './chart-math.ts';
import type { ChartDoneItem, ChartsData, PodiumState, ProjectRow, ProjectsData } from './types.ts';

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
export interface DoneGroup { stream: string; tab: string; n: number; items: ChartDoneItem[] }
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
    return { n: ids.length, groups: streams.map((stream) => ({ stream, tab: formatFragment(streamTabId(stream)), n: counts[stream]!, items: items.filter((i) => i.stream === stream) })) };
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
