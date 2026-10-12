/**
 * Runtime enforcement of the JSON contract in types.ts. A payload is untrusted until it has been through here:
 * every row is checked against a rule table, rows that fail are dropped (the rest of the payload still renders), and
 * only a payload with no usable shape at all is refused. Pure and DOM-free so node:test covers it.
 */
import type { Block, DocItem, EpicBrief, EpicDocs, EpicLine, EpicsData, LocalReview, LocalUnit, OpenPrsData, OpenPrsGroup, PrsRefreshStatus, AskCard, BlockedItem, ChartDoneItem, ChartsData, PrAge, PrRef, DeferredItem, DoneItem, FooterRow, HomeEpic, HomeLink, HomeTicket, HomeUnknown, PodiumState, ProjectRow, ProjectsData, WeekCount, PrCard, PrioritiesState, RailGroup, RailLink, StreamHome, WorkItem } from './types.ts';

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
    mergeable: str, mergeStateStatus: str, unresolved: num, review: str, flags: arrOf(str), twinOf: opt(num), stackedOn: opt(num), selfReview: opt(bool), createdAt: opt(str),
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

/** A priorities state from an untrusted value: rows that fail the rules are dropped and counted, anything unrecognised is `missing`. */
export function sanitizePriorities(v: unknown): { value: PrioritiesState; dropped: number } {
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
  const pri = sanitizePriorities(x.priorities);
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
  throughput: { date: str, total: num, byStream: COUNTS, ids: arrOf(str) } satisfies Shape,
  doneItems: { id: str, stream: str, text: str, finishedAt: str, ticket: opt(ref) } satisfies Shape,
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
  const doneItems = validRows(x.doneItems, CHART_ROWS.doneItems) as ChartDoneItem[];
  const prAge = sanitizePrAge(x.prAge);
  const q = x.reviewQueue;
  const reviewQueue: ChartsData['reviewQueue'] = isObj(q) && count(q.count) && count(q.cap) ? { count: q.count as number, cap: q.cap as number }
    : { unavailable: (isObj(q) && typeof q.unavailable === 'string' && q.unavailable) || 'the server did not send a review queue count' };
  const dropped = lost(x.days, days) + lost(x.throughput, throughput) + lost(x.ageBuckets, ageBuckets) + lost(x.doneItems, doneItems) + prAge.dropped
    + byState.dropped + byStream.dropped + byFamily.dropped + wholeMix + wholeModel;
  return {
    data: {
      days, throughput, ageBuckets, doneItems, prAge: prAge.value, reviewQueue,
      prMix: { byState: byState.value, byStream: byStream.value },
      modelMix: { byFamily: byFamily.value, source: model.source === 'tokens' ? 'tokens' : 'ledger' },
    },
    dropped,
  };
}

const PR_REF: Shape = { repo: str, number: num, title: str, url: str, stream: str, createdAt: opt(str) };
const NO_PR_AGE: PrAge = { buckets: [], unknownAge: { inQueue: [], other: [] }, drafts: 0 };

/** A PrAge from an untrusted value: PR refs that fail their rules are dropped and counted, a bucket with no label is dropped whole, anything else is empty. */
function sanitizePrAge(v: unknown): { value: PrAge; dropped: number } {
  if (!isObj(v)) return { value: NO_PR_AGE, dropped: v === undefined ? 0 : 1 };
  let dropped = 0;
  const refs = (list: unknown): PrRef[] => { const ok = validRows(list, PR_REF) as PrRef[]; dropped += lost(list, ok); return ok; };
  const raw = Array.isArray(v.buckets) ? v.buckets : [];
  const buckets = raw.filter(isObj).filter((b) => str(b.label)).map((b) => ({ label: b.label as string, inQueue: refs(b.inQueue), other: refs(b.other) }));
  dropped += raw.length - buckets.length;
  return { value: { buckets, unknownAge: { inQueue: refs(isObj(v.unknownAge) ? v.unknownAge.inQueue : undefined), other: refs(isObj(v.unknownAge) ? v.unknownAge.other : undefined) }, drafts: typeof v.drafts === 'number' && Number.isInteger(v.drafts) && v.drafts >= 0 ? v.drafts : 0 }, dropped };
}

const count: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const orNull = (c: Check): Check => (v) => v === null || c(v);

const HOME_TICKET: Shape = {
  id: str, title: str, status: str, priority: num, ref, prs: arrOf(ref), awaitsYou: bool,
  tracker: opt(ref), points: opt(num), prsMore: opt(count), quietDays: orNull(num),
};
const HOME_EPIC: Shape = {
  id: str, title: str, note: ref, status: str, total: count, closed: count, inProgress: count, blocked: count, notStarted: count,
  verify: shape({ required: bool, verified: count }), awaiting: count, unknowns: count, quietDays: orNull(num),
  tracker: opt(ref), next: opt(shape(HOME_TICKET)), prs: opt(arrOf(ref)), prsMore: opt(count),
};
const INLINE: Check = shape({ text: str, strong: opt(bool), em: opt(bool), code: opt(bool), link: opt(shape({ url: str, kind: oneOf('web', 'note') })) });
const RUNS = arrOf(INLINE);
const BLOCK_RULES: Record<string, Check> = {
  heading: shape({ level: (v) => v === 3 || v === 4, runs: RUNS }),
  paragraph: shape({ runs: RUNS }),
  quote: shape({ runs: RUNS }),
  list: shape({ ordered: bool, items: arrOf(shape({ runs: RUNS, children: arrOf(shape({ runs: RUNS })) })) }),
};
const DOC_ITEM: Shape = { title: str, kind: str, project: str, ticket: str, status: opt(str), updated: opt(str), url: opt(str) };
const BRIEF_STATES = oneOf('fresh', 'stale', 'missing', 'too-long', 'unreadable');

/** A brief from an untrusted value: a block of an unknown type or shape is skipped, and a brief whose state is unrecognised is dropped whole. Each loss counts one. */
function sanitizeBrief(v: unknown): { value?: EpicBrief; dropped: number } {
  if (v === undefined) return { dropped: 0 };
  if (!isObj(v) || !BRIEF_STATES(v.state) || !opt(str)(v.updated) || !opt(arrOf(str))(v.staleBecause) || !opt(ref)(v.ref)) return { dropped: 1 };
  const raw = Array.isArray(v.blocks) ? v.blocks : [];
  const blocks = raw.filter((b) => isObj(b) && typeof b.type === 'string' && Object.hasOwn(BLOCK_RULES, b.type) && (BLOCK_RULES[b.type] as Check)(b)) as Block[];
  return { value: { ...(v as unknown as EpicBrief), ...(Array.isArray(v.blocks) ? { blocks } : {}) }, dropped: raw.length - blocks.length };
}

/** A docs shelf from an untrusted value: a document that fails its rules is dropped from its group and counted; a group that is not a group is dropped too. */
function sanitizeDocs(v: unknown): { value?: EpicDocs; dropped: number } {
  if (v === undefined) return { dropped: 0 };
  if (!isObj(v) || !Array.isArray(v.groups) || !count(v.unattributedRecent)) return { dropped: 1 };
  let dropped = 0;
  const groups = v.groups.flatMap((g): EpicDocs['groups'] => {
    if (!isObj(g) || !str(g.kind) || !count(g.more) || !Array.isArray(g.items)) { dropped += 1; return []; }
    const items = validRows(g.items, DOC_ITEM) as DocItem[];
    dropped += lost(g.items, items);
    return [{ kind: g.kind as string, items, more: g.more as number }];
  });
  return { value: { groups, unattributedRecent: v.unattributedRecent as number }, dropped };
}

const RAIL_LINK: Shape = { label: str, kind: oneOf('note', 'tracker', 'pr', 'web'), url: str, meta: opt(str) };
const RAIL_GROUP: Shape = { group: oneOf('pinned', 'epics', 'docs', 'prs', 'runbooks'), more: count };
const DONE_MEANS: Shape = { epic: str, text: str };
const HOME_UNKNOWN: Shape = { kind: str, text: str, ref: opt(ref), epic: opt(str) };

/**
 * A StreamHome from an untrusted `GET /api/streams/:name/home` body, or null when it has no usable shape. Epics, tickets and
 * unknowns that fail their rules are dropped and counted, as sanitizeState does, so one bad row never hides the rest of the tab.
 * An epic whose counts do not add up is dropped too: its progress sentence would state a denominator the rows contradict.
 */
export function sanitizeHome(x: unknown): { home: StreamHome; dropped: number } | null {
  if (!isObj(x) || typeof x.stream !== 'string' || !Array.isArray(x.epics) || !isObj(x.left)) return null;
  const left = x.left;
  const epics = validRows(x.epics, HOME_EPIC).filter((e) => {
    const c = e as HomeEpic;
    return c.closed + c.inProgress + c.blocked + c.notStarted === c.total;
  }) as HomeEpic[];
  let extras = 0;
  for (const e of epics) {
    const b = sanitizeBrief((e as unknown as Record<string, unknown>).brief);
    const d = sanitizeDocs((e as unknown as Record<string, unknown>).docs);
    extras += b.dropped + d.dropped;
    delete e.brief;
    delete e.docs;
    if (b.value) e.brief = b.value;
    if (d.value) e.docs = d.value;
  }
  const groups = {
    inProgress: validRows(left.inProgress, HOME_TICKET) as HomeTicket[],
    blocked: validRows(left.blocked, HOME_TICKET) as HomeTicket[],
    notStarted: validRows(left.notStarted, HOME_TICKET) as HomeTicket[],
  };
  const loose = validRows(x.loose, HOME_TICKET) as HomeTicket[];
  const unknowns = validRows(x.unknowns, HOME_UNKNOWN) as HomeUnknown[];
  const doneMeans = validRows(x.doneMeans, DONE_MEANS) as StreamHome['doneMeans'];
  let linksDropped = lost(x.links, validRows(x.links, RAIL_GROUP));
  const links = validRows(x.links, RAIL_GROUP).flatMap((g): RailGroup[] => {
    const grp = g as RailGroup;
    if (!Array.isArray(grp.items)) { linksDropped += 1; return []; }
    const items = validRows(grp.items, RAIL_LINK) as RailLink[];
    linksDropped += lost(grp.items, items);
    return [{ group: grp.group, items, more: grp.more }];
  });
  const prs = isObj(x.freshness) && isObj(x.freshness.prs) && bool(x.freshness.prs.stale) && orNull(str)(x.freshness.prs.fetchedAt)
    ? { fetchedAt: x.freshness.prs.fetchedAt as string | null, stale: x.freshness.prs.stale as boolean }
    : { fetchedAt: null, stale: true };
  const dropped = extras + lost(x.epics, epics) + lost(x.loose, loose) + lost(x.unknowns, unknowns) + lost(x.doneMeans, doneMeans) + linksDropped
    + lost(left.inProgress, groups.inProgress) + lost(left.blocked, groups.blocked) + lost(left.notStarted, groups.notStarted);
  const truncated = count(left.truncated) ? left.truncated as number : 0;
  return { home: { stream: x.stream, epics, loose, left: { ...groups, truncated }, doneMeans, links, unknowns, freshness: { prs } }, dropped };
}

const EPIC_LINE: Shape = {
  id: str, title: str, note: ref, status: str, total: count, closed: count, inProgress: count, blocked: count, notStarted: count,
  awaiting: count, quietDays: orNull(num), tracker: opt(ref), next: opt(shape({ id: str, title: str, ref })), prs: arrOf(ref), prsMore: opt(count),
};

/**
 * An EpicsData from an untrusted `GET /api/epics` body, or null when it has no usable shape. A line that fails its rules, or
 * whose counts do not add up to its total (its fraction would state a denominator the numbers contradict), is dropped.
 */
export function sanitizeEpics(x: unknown): { data: EpicsData; dropped: number } | null {
  if (!isObj(x) || !Array.isArray(x.streams) || !Array.isArray(x.unfiled)) return null;
  let dropped = 0;
  const lines = (list: unknown): EpicLine[] => {
    const ok = validRows(list, EPIC_LINE).filter((e) => { const c = e as EpicLine; return c.closed + c.inProgress + c.blocked + c.notStarted === c.total; }) as EpicLine[];
    dropped += lost(list, ok);
    return ok;
  };
  const streams = x.streams.filter(isObj).filter((g) => str(g.stream)).map((g) => ({ stream: g.stream as string, epics: lines(g.epics) }));
  dropped += x.streams.length - streams.length;
  return { data: { streams, unfiled: lines(x.unfiled) }, dropped };
}

const LOCAL_UNIT: Shape = {
  id: str, repo: str, branch: str, head: str, ahead: count, at: str, subject: str, where: str, checkedOut: bool, base: str, command: str,
  verdict: shape({ state: oneOf('ship-it', 'needs-work', 'stale', 'none'), at: opt(str) }),
};

/**
 * A LocalReview from an untrusted `GET /api/local-review` body, or null when it has no usable shape. A unit that fails its rules
 * is dropped and counted. An unavailable queue must carry its reason: without one it would read as an empty queue, so it is refused.
 */
export function sanitizeLocalReview(x: unknown): { data: LocalReview; dropped: number } | null {
  if (!isObj(x) || !bool(x.available) || !str(x.generatedAt) || !Array.isArray(x.units)) return null;
  if (x.available === false && !(str(x.reason) && (x.reason as string).length > 0)) return null;
  const units = validRows(x.units, LOCAL_UNIT) as LocalUnit[];
  const notes = Array.isArray(x.notes) ? x.notes.filter((n): n is string => typeof n === 'string') : [];
  const reason = str(x.reason) ? { reason: x.reason as string } : {};
  return { data: { generatedAt: x.generatedAt as string, available: x.available as boolean, ...reason, units, more: count(x.more) ? x.more as number : 0, notes }, dropped: lost(x.units, units) };
}

const PROJECT_ROW: Shape = {
  stream: str, projects: arrOf(str), status: orNull(shape({ text: str, from: oneOf('context', 'priority') })), rank: orNull(count),
  asks: count, inflight: count, blocked: count, prs: count, oldestOpenDays: orNull(count), lastShipped: orNull(str), shippedWeek: count,
  state: oneOf('waiting on you', 'blocked', 'moving', 'quiet'),
};
const HOME_LINK: Shape = { label: str, kind: oneOf('pin', 'context', 'library'), stream: str, url: str };
const WEEK: Shape = { start: str, total: count, byStream: recordOf(count) };

/** ProjectsData from an untrusted `GET /api/projects` body, or null when it has no usable shape. Rows, links and weeks that fail their rules are dropped and counted. */
export function sanitizeProjects(x: unknown): { data: ProjectsData; dropped: number } | null {
  if (!isObj(x) || !str(x.generatedAt) || !str(x.today) || !Array.isArray(x.rows)) return null;
  const rows = validRows(x.rows, PROJECT_ROW) as ProjectRow[];
  const links = validRows(x.links, HOME_LINK) as HomeLink[];
  const weeks = validRows(x.weeks, WEEK) as WeekCount[];
  return { data: { generatedAt: x.generatedAt as string, today: x.today as string, rows, links, weeks }, dropped: lost(x.rows, rows) + lost(x.links, links) + lost(x.weeks, weeks) };
}

const OPEN_PR: Shape = {
  number: count, title: str, url: str, base: str, head: str, isDraft: bool, review: oneOf('approved', 'changes-requested', 'none'), unresolved: count,
  mergeable: oneOf('mergeable', 'conflicting', 'unknown'), twins: arrOf(count), ageDays: opt(num), ticket: opt(ref),
};
const OPEN_PRS_REPO: Shape = { repo: str, count, prs: arrOf(shape(OPEN_PR)) };

/**
 * OpenPrsData from an untrusted `GET /api/prs` body, or null when it has no usable shape. A repo block whose rows fail the rules is
 * dropped and counted, so a bad row never shows a count that disagrees with its table. Totals are recomputed from what survived.
 */
export function sanitizeOpenPrs(x: unknown): { data: OpenPrsData; dropped: number } | null {
  if (!isObj(x) || !str(x.generatedAt) || !Array.isArray(x.groups)) return null;
  const pd = isObj(x.prData) ? x.prData : null;
  if (!pd || !(pd.fetchedAt === null || str(pd.fetchedAt)) || !bool(pd.stale)) return null;
  let dropped = 0;
  const groups: OpenPrsGroup[] = [];
  for (const g of x.groups) {
    if (!isObj(g) || !oneOf('team', 'self-review')(g.id) || !str(g.label) || !Array.isArray(g.repos)) { dropped += 1; continue; }
    const repos = validRows(g.repos, OPEN_PRS_REPO) as { repo: string; count: number; prs: unknown[] }[];
    dropped += lost(g.repos, repos);
    const clean = repos.map((r) => ({ repo: r.repo, count: r.prs.length, prs: r.prs })) as OpenPrsGroup['repos'];
    if (clean.length > 0) groups.push({ id: g.id as 'team' | 'self-review', label: g.label as string, count: clean.reduce((n, r) => n + r.count, 0), repos: clean });
  }
  const failure = str(pd.failure) ? { failure: pd.failure as string } : {};
  return { data: { generatedAt: x.generatedAt as string, prData: { fetchedAt: pd.fetchedAt as string | null, stale: pd.stale as boolean, ...failure }, total: groups.reduce((n, g) => n + g.count, 0), groups }, dropped };
}

/** A refresh status from an untrusted body, or null when its state is not one of the five. The message is shown as text only. */
export function sanitizeRefreshStatus(x: unknown): PrsRefreshStatus | null {
  if (!isObj(x) || !oneOf('idle', 'running', 'done', 'failed', 'locked')(x.state)) return null;
  const out: PrsRefreshStatus = { state: x.state as PrsRefreshStatus['state'] };
  if (str(x.startedAt)) out.startedAt = x.startedAt as string;
  if (str(x.finishedAt)) out.finishedAt = x.finishedAt as string;
  if (str(x.message)) out.message = x.message as string;
  return out;
}
