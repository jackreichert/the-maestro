/**
 * The Podium web app's state: a pure reducer from the same inputs the Markdown page is rendered from (`gatherInputs`) to the
 * JSON the page needs. Links are data ({ label, url }), never HTML, and every URL is built here from the page settings, so
 * the client never makes one out of ledger text. No file, clock or process access; the caller passes the inputs.
 */
import { askRefs, keysIn, pairTwins, prFlagNames, splitAsk, stackParent, streamOrder, ticketNoteRef, trackerRef } from '../status-page/render.ts';
import type { BoardStatus, FooterData, Item, PageConfig, PageInput, Pr, Ref } from '../status-page/render.ts';
import { localDate } from '../status-page/priorities.ts';
import { askAgeDays } from './charts.ts';
import type { PrioritiesState } from '../status-page/priorities.ts';
import type { GatheredInputs } from '../status-page/generate.ts';

const OTHER = 'other';
/**
 * PR data older than this is flagged stale. The status-refresh watcher ticks about every 10 minutes when idle and reads GitHub only
 * when the data is over 5 minutes old (it renders from the cache alone in quiet hours), so 15 minutes means a tick was missed.
 */
export const PR_STALE_MS = 15 * 60_000;

export interface LinkData { label: string; url?: string }
export interface AskLinks { note?: LinkData; tracker: LinkData[]; prs: LinkData[] }
export interface AskCard { id: string; stream: string; needed: string; context: string; ageDays: number; date: string; ts?: string; links: AskLinks }
export interface WorkItem { id: string; stream: string; text: string; ticket?: string; links: LinkData[]; model?: string; since?: string }
export interface BlockedItem extends WorkItem { gate?: string }
export interface DoneItem extends WorkItem { closedAt?: string }
export interface DeferredItem extends WorkItem { until: string }
export interface PrCard {
  repo: string; short: string; number: number; title: string; url: string; stream: string; base: string; head: string;
  isDraft: boolean; ci: string; mergeable: string; mergeStateStatus: string; unresolved: number; review: string | null;
  /** What needs a look: CONFLICTING, CI FAIL, `N thr`, changes requested. */
  flags: string[];
  /** The develop PR this staging PR is the twin of. */
  twinOf?: number;
  /** The open PR this one is stacked on. */
  stackedOn?: number;
}

export interface PodiumState {
  generatedAt: string;
  today: string;
  tz: string;
  /** Display order, `other` last. */
  streams: string[];
  priorities: PrioritiesState;
  footer: FooterData['ledger'];
  prData: { fetchedAt: string | null; stale: boolean; failure?: string };
  asks: AskCard[];
  working: WorkItem[];
  queued: WorkItem[];
  blocked: BlockedItem[];
  done: DoneItem[];
  deferred: DeferredItem[];
  prs: PrCard[];
}

/** A link reference as plain data: the Markdown-only `nowrap` hint dropped. */
const link = ({ label, url }: Ref): LinkData => (url === undefined ? { label } : { label, url });

/** The board and PRs as the page shows them. */
export function buildState(input: GatheredInputs): PodiumState {
  const { now, status, triage, prs, prData, ticketMap, priorities, config } = input;
  const tickets = new Map<string, string>();
  for (const [t, list] of Object.entries(ticketMap)) for (const id of list) tickets.set(id, t);
  const meta = new Map(triage.items.map((i) => [i.id, i]));
  const priorityStreams = priorities.state === 'ok' ? priorities.items.map((p) => p.stream) : [];
  const streams = streamOrder(config, [...status.awaiting.map((a) => a.stream), ...status.inflight.map((i) => i.stream), ...status.queued.map((i) => i.stream), ...prs.map((p) => p.stream), ...priorityStreams]);
  const streamOf = (i: { stream?: string }): string => (streams.includes(i.stream ?? '') ? i.stream! : OTHER);
  const noteOf = (i: Item): string | undefined => i.ticket || meta.get(i.id)?.ticket || tickets.get(i.id) || undefined;
  const work = (i: Item): WorkItem => {
    const ticket = i.ticket || tickets.get(i.id) || undefined;
    const links = [...(ticket ? [ticketNoteRef(config, ticket)] : []), ...keysIn(config, i.text).slice(0, 2).map((k) => trackerRef(config, k))].map(link);
    return { id: i.id, stream: streamOf(i), text: i.text, ...(ticket ? { ticket } : {}), links, ...(i.model ? { model: i.model } : {}), ...(i.stateTs ?? i.ts ? { since: i.stateTs ?? i.ts } : {}) };
  };
  const today = localDate(now, config.tz);
  return {
    generatedAt: now.toISOString(), today, tz: config.tz, streams, priorities: structuredClone(priorities),
    footer: structuredClone(status.footer?.ledger ?? []),
    prData: prDataState(prData, now),
    asks: status.awaiting.map((a) => askCard(config, a, prs, noteOf(a), streamOf(a), now)),
    working: status.inflight.map(work),
    queued: status.queued.map(work),
    blocked: status.blocked.map((b) => ({ ...work(b), ...(meta.get(b.id)?.gate ? { gate: meta.get(b.id)?.gate } : {}) })),
    done: status.done.map((d) => ({ ...work(d), ...(closedAt(d) ? { closedAt: closedAt(d) } : {}) })),
    deferred: triage.items.filter((i) => i.deferredUntil).map((i) => ({ ...work(i), until: i.deferredUntil as string })),
    prs: streams.flatMap((s) => prCards(config, prs.filter((p) => p.stream === s), prs)),
  };
}

function prDataState(data: PageInput['prData'], now: Date): PodiumState['prData'] {
  const stale = !data.fetchedAt || now.getTime() - data.fetchedAt.getTime() > PR_STALE_MS;
  return { fetchedAt: data.fetchedAt ? data.fetchedAt.toISOString() : null, stale, ...(data.failure ? { failure: data.failure } : {}) };
}

/** `closedBy.ts` when the board carries the closing row (a `done` item), else the item's own time. */
function closedAt(d: BoardStatus['done'][number]): string | undefined {
  return (d as { closedBy?: { ts?: string } | null }).closedBy?.ts ?? d.ts;
}

/** The decision, its context and its links, with the age in whole page days (`askAgeDays`, the same figure the age chart buckets). */
function askCard(config: PageConfig, a: Item, prs: Pr[], ticket: string | undefined, stream: string, now: Date): AskCard {
  const refs = askRefs(config, a, prs, ticket);
  const { needed, context } = splitAsk(a.text);
  return {
    id: a.id, stream, needed, context, ageDays: askAgeDays(a, now, config.tz), date: a.date, ...(a.ts ? { ts: a.ts } : {}),
    links: { ...(refs.note ? { note: link(refs.note) } : {}), tracker: refs.tracker.map(link), prs: refs.prs.map(link) },
  };
}

/** One stream's PRs in the Markdown table's order, a staging twin pointing at its develop PR and a stacked PR at its parent. */
function prCards(config: PageConfig, mine: Pr[], all: Pr[]): PrCard[] {
  return pairTwins(config, mine).flatMap((row) => [row.dev && prCard(row.dev, all), row.stg && prCard(row.stg, all, row.dev)]).filter((c): c is PrCard => !!c);
}

function prCard(p: Pr, all: Pr[], twinOf?: Pr): PrCard {
  const parent = stackParent(p, all);
  return {
    repo: p.repo, short: p.short, number: p.number, title: p.title, url: p.url, stream: p.stream, base: p.baseRefName, head: p.headRefName,
    isDraft: p.isDraft, ci: p.ci, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, unresolved: p.unresolved, review: p.reviewDecision,
    flags: prFlagNames(p), ...(twinOf ? { twinOf: twinOf.number } : {}), ...(parent ? { stackedOn: parent.number } : {}),
  };
}
