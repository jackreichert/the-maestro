/**
 * Runtime enforcement of the JSON contract in types.ts. A payload is untrusted until it has been through here:
 * every row is checked against a rule table, rows that fail are dropped (the rest of the payload still renders), and
 * only a payload with no usable shape at all is refused. Pure and DOM-free so node:test covers it.
 */
import type { AskCard, BlockedItem, ChartsData, DeferredItem, DoneItem, FooterRow, PodiumState, PrCard, PrioritiesState, WorkItem } from './types.ts';

type Check = (v: unknown) => boolean;
type Shape = Record<string, Check>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const oneOf = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const arrOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const recordOf = (c: Check): Check => (v) => isObj(v) && Object.values(v).every(c);
const shape = (s: Shape): Check => (v) => isObj(v) && Object.entries(s).every(([k, c]) => c(v[k]));

const ref = shape({ label: str, url: opt(str) });
const links = shape({ note: opt(ref), tracker: arrOf(ref), prs: arrOf(ref) });

const WORK: Shape = { id: str, stream: str, text: str, since: str, ticket: opt(ref), links, model: opt(str) };
const ROW_RULES = {
  asks: {
    id: str, stream: str, needed: str, context: str, date: str, ts: str, ageDays: num, links,
    recommend: opt(str), door: opt(oneOf('one-way', 'two-way')), default: opt(str), by: opt(str), class: opt(oneOf('expedite', 'fixed-date', 'standard', 'intangible')), paste: opt(str),
  } satisfies Shape,
  working: WORK,
  queued: WORK,
  blocked: { ...WORK, gate: opt(str) },
  done: { ...WORK, closedAt: str },
  deferred: { ...WORK, until: str },
  prs: {
    repo: str, short: str, number: num, title: str, url: str, stream: str, base: str, head: str, isDraft: bool, ci: str,
    mergeable: str, mergeStateStatus: str, unresolved: num, review: str, flags: arrOf(str), twinOf: opt(num), stackedOn: opt(num),
  } satisfies Shape,
  footer: { stream: str, asks: num, working: num, queued: num, blocked: num, done: num } satisfies Shape,
};

type RowKey = keyof typeof ROW_RULES;
const ROW_KEYS = Object.keys(ROW_RULES) as RowKey[];

const PRIORITY_RULES: Shape = { text: str, stream: opt(str) };

/** The rows of `v` that satisfy `rule`; a missing or non-array list is empty. */
function validRows(v: unknown, rule: Shape): unknown[] {
  return Array.isArray(v) ? v.filter(shape(rule)) : [];
}

/** How many entries of a list were left out of its filtered copy; a non-array list has none to lose. */
const lost = (v: unknown, kept: unknown[]): number => (Array.isArray(v) ? v.length - kept.length : 0);

function priorities(v: unknown): { value: PrioritiesState; dropped: number } {
  if (isObj(v) && v.state === 'ok' && str(v.date)) {
    const items = validRows(v.items, PRIORITY_RULES) as { text: string; stream?: string }[];
    return { value: { state: 'ok', date: v.date as string, items }, dropped: lost(v.items, items) };
  }
  if (isObj(v) && v.state === 'stale' && str(v.date)) return { value: { state: 'stale', date: v.date as string }, dropped: 0 };
  return { value: { state: 'missing' }, dropped: 0 };
}

/**
 * The markdown fragment for a tab, or undefined. Fragments are keyed by stream name, which is data: a stream called
 * `constructor` must not find Object.prototype's function, so only own properties count.
 */
export function fragmentFor(fragments: Record<string, string> | undefined, stream: string): string | undefined {
  return fragments !== undefined && Object.hasOwn(fragments, stream) ? fragments[stream] : undefined;
}

/** A whole number of at least 1, else the fallback. */
const wholeAtLeastOne = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);
/** The cap when the server names none (an older server, or the bundled sample data). */
const DEFAULT_PRIORITIES_MAX = 5;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A PodiumState built only from what passed its rules, or null when the payload is not an object with a streams array.
 * Dropped rows are counted in `dropped` so a caller can say so.
 */
export function sanitizeState(x: unknown): { state: PodiumState; dropped: number } | null {
  if (!isObj(x) || !arrOf(str)(x.streams)) return null;
  let dropped = 0;
  const rows = {} as Record<RowKey, unknown[]>;
  for (const key of ROW_KEYS) {
    rows[key] = validRows(x[key], ROW_RULES[key]);
    dropped += lost(x[key], rows[key]);
  }
  const kept = isObj(x.fragments) ? Object.entries(x.fragments).filter(([, v]) => str(v)) : undefined;
  if (kept) dropped += Object.keys(x.fragments as object).length - kept.length;
  const fragments = kept ? Object.fromEntries(kept) as Record<string, string> : undefined;
  const pri = priorities(x.priorities);
  dropped += pri.dropped;
  const prData = isObj(x.prData) && bool(x.prData.stale) && (x.prData.fetchedAt === null || str(x.prData.fetchedAt))
    ? { fetchedAt: x.prData.fetchedAt as string | null, stale: x.prData.stale as boolean }
    : { fetchedAt: null, stale: true };
  const state: PodiumState = {
    generatedAt: text(x.generatedAt), today: text(x.today), tz: text(x.tz), seq: text(x.seq),
    streams: x.streams as string[], priorities: pri.value, prioritiesMax: wholeAtLeastOne(x.prioritiesMax, DEFAULT_PRIORITIES_MAX), prData, fragments,
    asks: rows.asks as AskCard[], working: rows.working as WorkItem[], queued: rows.queued as WorkItem[], blocked: rows.blocked as BlockedItem[],
    done: rows.done as DoneItem[], deferred: rows.deferred as DeferredItem[], prs: rows.prs as PrCard[], footer: rows.footer as FooterRow[],
  };
  return { state, dropped };
}

const COUNTS = recordOf(num);
const CHART_ROWS = {
  throughput: { date: str, total: num, byStream: COUNTS } satisfies Shape,
  ageBuckets: { label: str, count: num, ids: arrOf(str) } satisfies Shape,
};

/** `v` when it passes `check`, else `empty`; a present-but-invalid value counts as one dropped part. */
function part<T>(v: unknown, check: Check, empty: T): { value: T; dropped: number } {
  if (check(v)) return { value: v as T, dropped: 0 };
  return { value: empty, dropped: v === undefined ? 0 : 1 };
}

/**
 * A ChartsData built only from what passed its rules, or null when the payload is not an object. Bad parts become empty.
 * `dropped` counts every row, day entry or whole part (a mix table) that was left out, as sanitizeState does.
 */
export function sanitizeCharts(x: unknown): { data: ChartsData; dropped: number } | null {
  if (!isObj(x)) return null;
  const mix = isObj(x.prMix) ? x.prMix : {};
  const model = isObj(x.modelMix) ? x.modelMix : {};
  const days = Array.isArray(x.days) ? x.days.filter(str) as string[] : [];
  const throughput = validRows(x.throughput, CHART_ROWS.throughput) as ChartsData['throughput'];
  const ageBuckets = validRows(x.ageBuckets, CHART_ROWS.ageBuckets) as ChartsData['ageBuckets'];
  const byState = part<Record<string, number>>(mix.byState, COUNTS, {});
  const byStream = part<Record<string, Record<string, number>>>(mix.byStream, recordOf(COUNTS), {});
  const byFamily = part<Record<string, number>>(model.byFamily, COUNTS, {});
  const wholeMix = x.prMix !== undefined && !isObj(x.prMix) ? 1 : 0;
  const wholeModel = x.modelMix !== undefined && !isObj(x.modelMix) ? 1 : 0;
  const dropped = lost(x.days, days) + lost(x.throughput, throughput) + lost(x.ageBuckets, ageBuckets)
    + byState.dropped + byStream.dropped + byFamily.dropped + wholeMix + wholeModel;
  return {
    data: {
      days, throughput, ageBuckets,
      prMix: { byState: byState.value, byStream: byStream.value },
      modelMix: { byFamily: byFamily.value, source: model.source === 'tokens' ? 'tokens' : 'ledger' },
    },
    dropped,
  };
}
