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
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const arrOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const recordOf = (c: Check): Check => (v) => isObj(v) && Object.values(v).every(c);
const shape = (s: Shape): Check => (v) => isObj(v) && Object.entries(s).every(([k, c]) => c(v[k]));

const ref = shape({ label: str, url: opt(str) });
const links = shape({ note: opt(ref), tracker: arrOf(ref), prs: arrOf(ref) });

const WORK: Shape = { id: str, stream: str, text: str, since: str, ticket: opt(ref), links, model: opt(str) };
const ROW_RULES = {
  asks: { id: str, stream: str, needed: str, context: str, date: str, ts: str, ageDays: num, links } satisfies Shape,
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

function priorities(v: unknown): PrioritiesState {
  if (isObj(v) && v.state === 'ok' && str(v.date)) return { state: 'ok', date: v.date as string, items: validRows(v.items, PRIORITY_RULES) as { text: string; stream?: string }[] };
  if (isObj(v) && v.state === 'stale' && str(v.date)) return { state: 'stale', date: v.date as string };
  return { state: 'missing' };
}

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
    dropped += (Array.isArray(x[key]) ? (x[key] as unknown[]).length : 0) - rows[key].length;
  }
  const fragments = isObj(x.fragments) ? Object.fromEntries(Object.entries(x.fragments).filter(([, v]) => str(v))) as Record<string, string> : undefined;
  const prData = isObj(x.prData) && bool(x.prData.stale) && (x.prData.fetchedAt === null || str(x.prData.fetchedAt))
    ? { fetchedAt: x.prData.fetchedAt as string | null, stale: x.prData.stale as boolean }
    : { fetchedAt: null, stale: true };
  const state: PodiumState = {
    generatedAt: text(x.generatedAt), today: text(x.today), tz: text(x.tz), seq: text(x.seq),
    streams: x.streams as string[], priorities: priorities(x.priorities), prData, fragments,
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

/** A ChartsData built only from what passed its rules, or null when the payload is not an object. Bad parts become empty. */
export function sanitizeCharts(x: unknown): ChartsData | null {
  if (!isObj(x)) return null;
  const mix = isObj(x.prMix) ? x.prMix : {};
  const model = isObj(x.modelMix) ? x.modelMix : {};
  return {
    days: Array.isArray(x.days) ? x.days.filter(str) as string[] : [],
    throughput: validRows(x.throughput, CHART_ROWS.throughput) as ChartsData['throughput'],
    ageBuckets: validRows(x.ageBuckets, CHART_ROWS.ageBuckets) as ChartsData['ageBuckets'],
    prMix: {
      byState: COUNTS(mix.byState) ? mix.byState as Record<string, number> : {},
      byStream: recordOf(COUNTS)(mix.byStream) ? mix.byStream as Record<string, Record<string, number>> : {},
    },
    modelMix: {
      byFamily: COUNTS(model.byFamily) ? model.byFamily as Record<string, number> : {},
      source: model.source === 'tokens' ? 'tokens' : 'ledger',
    },
  };
}
