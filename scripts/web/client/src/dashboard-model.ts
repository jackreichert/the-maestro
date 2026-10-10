/** What the Dashboard shows, worked out from the state and charts payloads. Pure and DOM-free: the view only draws it. */
import { MAX_SERIES, isOther } from './chart-math.ts';
import { oldestFirst } from './glance.ts';
import { formatFragment, streamTabId } from './tabs.ts';
import type { ChartDoneItem, ChartsData, PodiumState, PrRef, Ref } from './types.ts';

/** Rows a quadrant's list shows before it points at the full table. */
export const LIST_ROWS = 5;

/** One list row: a full-width link. `url` is a server-built link when there is one; `tab` is the in-page fallback. */
export interface Row { key: string; text: string; meta: string; tab: string; url?: string }

/** Where the asks are answered: the Board, showing only the asks. The Dashboard never answers one itself. */
export const ASKS_HREF = formatFragment('overview', 'asks');
export const WORKING_HREF = formatFragment('overview', 'working');

/** The colour class (`c-1`..`c-8`, or `c-other`) of each stream, by its place in `streams`, so a stream keeps its colour on every chart and after a reload. */
export function streamColors(streams: string[]): (name: string) => string {
  const slot = new Map<string, number>();
  for (const name of streams) if (!isOther(name) && !slot.has(name)) slot.set(name, slot.size);
  return (name) => {
    const i = slot.get(name);
    return i === undefined || i >= MAX_SERIES ? 'c-other' : `c-${i + 1}`;
  };
}

export interface NeedsYou { n: number; buckets: { label: string; count: number }[] | null; rows: Row[] }

export function needsYou(st: PodiumState, charts: ChartsData | null): NeedsYou {
  const rows = oldestFirst(st.asks).map((a): Row => ({
    key: a.id, text: a.needed, meta: a.ageDays >= 1 ? `${Math.floor(a.ageDays)} d` : 'today', tab: ASKS_HREF,
  }));
  return { n: st.asks.length, buckets: charts ? charts.ageBuckets.map((b) => ({ label: b.label, count: b.count })) : null, rows };
}

export interface PrColumn { label: string; inQueue: PrRef[]; other: PrRef[]; undated: boolean }
export interface PrsWaiting {
  n: number;
  columns: PrColumn[] | null;
  drafts: number;
  queue: { count: number; cap: number } | { unavailable: string } | null;
  /** In the review queue, oldest first, then the PRs with no date. */
  rows: Row[];
  /** "PR snapshot 3 h old", or null when the snapshot is fresh. */
  stale: string | null;
}

const prRow = (p: PrRef, meta: string): Row => ({ key: `${p.repo}#${p.number}`, text: p.title, meta: `${p.repo}#${p.number} · ${meta}`, tab: formatFragment(streamTabId(p.stream)), url: p.url });

export function prsWaiting(st: PodiumState, charts: ChartsData | null): PrsWaiting {
  const age = charts?.prAge;
  const buckets = age?.buckets ?? [];
  const columns: PrColumn[] | null = age
    ? [...buckets.map((b) => ({ label: b.label, inQueue: b.inQueue, other: b.other, undated: false })),
      ...(age.unknownAge.length > 0 ? [{ label: 'no date', inQueue: [], other: age.unknownAge, undated: true }] : [])]
    : null;
  // Oldest first: the buckets run newest to oldest, so walk them backwards.
  const rows = [...buckets].reverse().flatMap((b) => [...b.inQueue].reverse().map((p) => prRow(p, b.label)));
  const n = columns ? columns.reduce((t, c) => t + c.inQueue.length + c.other.length, 0) : 0;
  return { n, columns, drafts: age?.drafts ?? 0, queue: charts?.reviewQueue ?? null, rows, stale: snapshotNote(st) };
}

/** The PR snapshot's age, as a warning, or null while it is fresh. A missing fetch time is said outright. */
export function snapshotNote(st: PodiumState): string | null {
  if (!st.prData.stale) return null;
  const at = st.prData.fetchedAt ? Date.parse(st.prData.fetchedAt) : Number.NaN;
  const now = Date.parse(st.generatedAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 'PR snapshot has never been fetched';
  const hours = Math.max(1, Math.floor((now - at) / 3_600_000));
  return `PR snapshot ${hours} h old`;
}

export interface FlightBar { stream: string; tab: string; count: number }
export interface InFlight { n: number; bars: FlightBar[]; rows: Row[] }

/** In-flight items by stream, most first; ties keep the stream order. Streams with nothing in flight are left out. */
export function inFlight(st: PodiumState): InFlight {
  const order = new Map(st.streams.map((s, i) => [s, i]));
  const counts = new Map<string, number>();
  for (const w of st.working) counts.set(w.stream, (counts.get(w.stream) ?? 0) + 1);
  const bars = [...counts].map(([stream, count]) => ({ stream, tab: formatFragment(streamTabId(stream)), count }))
    .sort((a, b) => (b.count - a.count) || ((order.get(a.stream) ?? 1e9) - (order.get(b.stream) ?? 1e9)) || a.stream.localeCompare(b.stream));
  const rows = st.working.map((w): Row => ({ key: w.id, text: w.text, meta: w.stream, tab: formatFragment(streamTabId(w.stream)), ...(w.ticket?.url ? { url: w.ticket.url } : {}) }));
  return { n: st.working.length, bars, rows };
}

export interface DoneDay { date: string; total: number; byStream: Record<string, number>; ids: string[] }
export interface DonePerDay { days: DoneDay[]; total: number; streams: string[] }

/** The 14-day window: each day's count by stream, and the streams that finished anything, in the page's stream order. */
export function donePerDay(st: PodiumState, charts: ChartsData | null): DonePerDay | null {
  if (!charts) return null;
  const days = charts.throughput.map((d) => ({ date: d.date, total: d.total, byStream: d.byStream, ids: d.ids }));
  const seen = new Set(days.flatMap((d) => Object.keys(d.byStream)));
  const order = new Map(st.streams.map((s, i) => [s, i]));
  const streams = [...seen].sort((a, b) => (isOther(a) ? 1 : 0) - (isOther(b) ? 1 : 0) || ((order.get(a) ?? 1e9) - (order.get(b) ?? 1e9)) || a.localeCompare(b));
  return { days, total: days.reduce((t, d) => t + d.total, 0), streams };
}

export interface DayItems { rows: Row[]; missing: number }

/** The items finished on one day. `missing` counts items the server's capped list no longer holds. */
export function doneOn(day: DoneDay, items: ChartDoneItem[]): DayItems {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = day.ids.flatMap((id): Row[] => {
    const it = byId.get(id);
    return it ? [doneRow(it)] : [];
  });
  return { rows, missing: day.ids.length - rows.length };
}

function doneRow(it: ChartDoneItem): Row {
  const ref: Ref | undefined = it.ticket;
  return { key: it.id, text: it.text, meta: it.stream, tab: formatFragment(streamTabId(it.stream)), ...(ref?.url ? { url: ref.url } : {}) };
}
