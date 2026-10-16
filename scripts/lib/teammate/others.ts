/**
 * Every open teammate PR, for the Podium's Others' PRs tab: one scoped GitHub search, reduced to the fields the tab shows and remembered in
 * `<statusDir>/.now-others-prs.json`. The status-page rebuild (the loop's status-refresh cadence, and the Open PRs Refresh button) writes it; the
 * web server only reads it, so a page load never reaches GitHub. A failed read keeps the last good set and records why.
 * The search is scoped to the review-queue owners and never runs unscoped. Own PRs, bots and self-review repos are left out here (drafts are kept and flagged); the web read applies the owner, own-PR and self-review scope again (the cache holds only what passed here). Threads and requested reviewers are read from the first 100 and 20, so larger counts are capped.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBotAuthor } from '../github-bots.ts';
import { readNodesById, searchPagesPartial } from '../gh-search.ts';
import { isSelfReview } from '../self-review.ts';
import { isFormerTeammate } from './former.ts';
import { writeAtomic } from '../status-page/seen.ts';
import type { Run } from '../types.ts';

export const OTHERS_CACHE = '.now-others-prs.json';
/** A PR with open threads has its thread authors read again after this long, whether or not GitHub says it changed. */
export const DETAIL_REFRESH_MS = 30 * 60_000;

/** One open teammate PR, as stored. Logins are GitHub's own; nothing here is free text from a comment. */
export interface OtherPr {
  repo: string; number: number; title: string; url: string; author: string; authorName?: string; base: string; head: string;
  /** The head commit's sha (`headRefOid`), so an ignore can be pinned to it; absent in a cache written before it was read. */
  headSha?: string;
  createdAt: string; updatedAt: string;
  /** Logins of users asked to review (teams are not listed). */
  requested: string[];
  /** GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when the repo requires none. */
  decision: string | null;
  /** Unresolved review threads, and how many of them Copilot opened. */
  unresolved: number; copilotThreads: number;
  /** What the sub-tabs sort by; absent in a cache written before they existed (then read as clean). `ci` is the head commit's check rollup state. */
  isDraft?: boolean; ci?: string; mergeable?: string; labels?: string[];
  /** The user's latest submitted review (state, when), and when the head commit was made, so a review the author has not pushed after reads as waiting. */
  yourReview?: { state: string; at: string }; headAt?: string;
  /** Submitted reviews by anyone (of the last 30), so a PR nobody has looked at reads as not yet asked for review. */
  reviewCount?: number;
  /** When `copilotThreads` was last read from GitHub (ms), so it is read again after DETAIL_REFRESH_MS even if updatedAt did not move (resolving a thread may not move it). */
  detailAt?: number;
}
export interface OthersCache { fetchedAt: Date | null; failure?: string; prs: OtherPr[] }
export interface OthersScope { owners: readonly string[]; selfRepos: readonly string[]; self: string; /** Logins of people who have left (`former_teammates`); their PRs are dropped. */ former?: readonly string[];
  /** Only PRs updated in the last this many days are searched for (`others_prs_drop_days`): the tab drops older ones anyway, and 16 pages of 50 do not read reliably. Absent means no age bound. */
  sinceDays?: number }

interface Login { login?: string; __typename?: string; name?: string | null }
interface Node {
  id?: string; number?: number; title?: string; url?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string; baseRefName?: string; headRefName?: string; headRefOid?: string;
  reviewDecision?: string | null; mergeable?: string; author?: Login | null;
  labels?: { nodes?: ({ name?: string } | null)[] };
  reviews?: { nodes?: ({ author?: Login | null; state?: string; submittedAt?: string } | null)[] };
  commits?: { nodes?: ({ commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null } } | null)[] }; repository?: { nameWithOwner?: string };
  reviewRequests?: { nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[] };
  reviewThreads?: { nodes?: ({ isResolved?: boolean; comments?: { nodes?: ({ author?: Login | null } | null)[] } } | null)[] };
}

/** The search for other people's open PRs (drafts included) in the owners; null for no owner, so there is never an unscoped search. */
export function othersSearch(owners: readonly string[], opts: { former?: readonly string[]; sinceDays?: number; now?: number } = {}): string | null {
  const safe = owners.filter((o) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(o));
  if (!safe.length) return null;
  const gone = (opts.former ?? []).filter((l) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(l)).map((l) => `-author:${l}`);
  const since = opts.sinceDays !== undefined && opts.sinceDays > 0 ? [`updated:>=${new Date((opts.now ?? Date.now()) - opts.sinceDays * 86_400_000).toISOString().slice(0, 10)}`] : [];
  return ['is:pr is:open archived:false -author:@me -review:approved', ...gone, ...since, ...safe.map((o) => `user:${o}`)].join(' ');
}

export const othersQuery = (search: string): string => `query($after: String) { search(query: "${search}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  id number title url isDraft createdAt updatedAt baseRefName headRefName headRefOid reviewDecision mergeable author { login __typename ... on User { name } } repository { nameWithOwner }
  labels(first: 10) { nodes { name } }
  reviews(last: 30) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
} } } }`;

/**
 * Who opened each thread, read by id (lib/gh-search.ts) for the PRs that have open threads. The search above leaves the comments out because GraphQL
 * charges for the connections nested in a search's nodes: with them, one page of 50 PRs cost 53 points and the whole list (784 PRs, 16 pages) about 850 a refresh.
 */
const THREAD_AUTHORS = 'reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } } }';

const isCopilot = (a: Login | null | undefined): boolean => /copilot/i.test(a?.login ?? '');

/** The nodes worth listing, reduced. Drops bots, the user's own PRs, self-review repos and anything not shaped like a PR. */
export function reduceOthers(nodes: readonly Node[], scope: OthersScope): OtherPr[] {
  const self = scope.self.toLowerCase();
  const out: OtherPr[] = [];
  for (const n of nodes) {
    const repo = n.repository?.nameWithOwner;
    const author = n.author?.login;
    if (!repo || !author || typeof n.number !== 'number' || !n.url || typeof n.isDraft !== 'boolean') continue;
    if (isBotAuthor(n.author) || (self !== '' && author.toLowerCase() === self) || isSelfReview(repo, scope.selfRepos) || isFormerTeammate(author, scope.former)) continue;
    if (n.reviewDecision === 'APPROVED' || (n.reviews?.nodes ?? []).some((r) => r?.state === 'APPROVED')) continue;
    if (!scope.owners.some((o) => o.toLowerCase() === repo.split('/')[0]?.toLowerCase())) continue;
    const mine = (n.reviews?.nodes ?? []).filter((r) => r && r.state && r.state !== 'PENDING' && r.submittedAt && self !== '' && (r.author?.login ?? '').toLowerCase() === self).sort((a, b) => (a?.submittedAt ?? '').localeCompare(b?.submittedAt ?? '')).pop();
    const head = n.commits?.nodes?.[0]?.commit;
    const open = (n.reviewThreads?.nodes ?? []).filter((t) => t && t.isResolved === false);
    out.push({
      repo, number: n.number, title: n.title ?? '', url: n.url, author, ...(n.author?.name?.trim() ? { authorName: n.author.name.trim().slice(0, 80) } : {}), base: n.baseRefName ?? '', head: n.headRefName ?? '', ...(typeof n.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(n.headRefOid) ? { headSha: n.headRefOid } : {}),
      createdAt: n.createdAt ?? '', updatedAt: n.updatedAt ?? n.createdAt ?? '',
      requested: (n.reviewRequests?.nodes ?? []).map((r) => r?.requestedReviewer?.login).filter((l): l is string => !!l),
      decision: n.reviewDecision ?? null, unresolved: open.length, copilotThreads: open.filter((t) => isCopilot(t?.comments?.nodes?.[0]?.author)).length,
      isDraft: n.isDraft, ...(head?.statusCheckRollup?.state ? { ci: head.statusCheckRollup.state } : {}), ...(n.mergeable ? { mergeable: n.mergeable } : {}),
      labels: (n.labels?.nodes ?? []).map((l) => l?.name ?? '').filter(Boolean).slice(0, 10),
      ...(mine?.state && mine.submittedAt ? { yourReview: { state: mine.state, at: mine.submittedAt } } : {}), ...(head?.committedDate ? { headAt: head.committedDate } : {}),
      reviewCount: (n.reviews?.nodes ?? []).filter((r) => r && r.state && r.state !== 'PENDING').length,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Reads GitHub and reduces; throws when GitHub cannot be read. With no owner there is nothing to read and the list is empty.
 * `known` is the last stored list: a PR in it whose updatedAt has not moved keeps its Copilot thread count, so only changed PRs with open threads are read in detail.
 */
export function fetchOthers(scope: OthersScope, run?: Run, known: readonly OtherPr[] = [], now: number = Date.now()): OtherPr[] {
  const search = othersSearch(scope.owners, { ...(scope.former ? { former: scope.former } : {}), ...(scope.sinceDays !== undefined ? { sinceDays: scope.sinceDays } : {}), now });
  if (!search) return [];
  const read = searchPagesPartial<Node>(othersQuery(search), run);
  const nodes = read.nodes;
  const before = new Map(known.map((p) => [p.url, p]));
  const hasOpen = (n: Node): boolean => (n.reviewThreads?.nodes ?? []).some((t) => t && t.isResolved === false);
  const stale = (n: Node): boolean => {
    const old = before.get(n.url ?? '');
    return n.updatedAt === undefined || old?.updatedAt !== n.updatedAt || old.detailAt === undefined || now - old.detailAt >= DETAIL_REFRESH_MS;
  };
  const detail = readNodesById<{ id: string; reviewThreads: Node['reviewThreads'] }>(nodes.filter((n) => n.id && hasOpen(n) && stale(n)).map((n) => n.id as string), THREAD_AUTHORS, run);
  const detailed = nodes.map((n) => (n.id && detail.has(n.id) ? { ...n, reviewThreads: detail.get(n.id)?.reviewThreads } : n));
  const byUrl = new Map(nodes.map((n) => [n.url, n]));
  const reduced = reduceOthers(detailed, scope).map((p) => {
    const id = byUrl.get(p.url)?.id;
    if (p.unresolved === 0) return p;
    const old = before.get(p.url);
    return id && detail.has(id) ? { ...p, detailAt: now } : { ...p, copilotThreads: old?.copilotThreads ?? 0, ...(old?.detailAt !== undefined ? { detailAt: old.detailAt } : {}) };
  });
  if (!read.error) return reduced;
  // A page failed part-way: keep the pages that were read and fill in from the last good set, so a half read never replaces a whole list nor loses it.
  const got = new Set(reduced.map((p) => p.url));
  const keptOld = known.filter((p) => !got.has(p.url) && !isFormerTeammate(p.author, scope.former));
  throw new PartialOthers([...reduced, ...keptOld].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), read.error.message);
}

/** Thrown by `fetchOthers` when a later page failed: `prs` is what was read merged with the last good set, `message` is why the read stopped. */
export class PartialOthers extends Error {
  readonly prs: OtherPr[];
  constructor(prs: OtherPr[], message: string) { super(message); this.prs = prs; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOther = (v: unknown): v is OtherPr => isObj(v)
  && ['repo', 'title', 'url', 'author', 'base', 'head', 'createdAt', 'updatedAt'].every((k) => typeof v[k] === 'string')
  && (v.authorName === undefined || typeof v.authorName === 'string') && typeof v.number === 'number' && Number.isSafeInteger(v.number) && typeof v.unresolved === 'number' && typeof v.copilotThreads === 'number' && (v.reviewCount === undefined || typeof v.reviewCount === 'number') && (v.isDraft === undefined || typeof v.isDraft === 'boolean') && (v.labels === undefined || (Array.isArray(v.labels) && v.labels.every((l) => typeof l === 'string')))
  && (v.decision === null || typeof v.decision === 'string') && Array.isArray(v.requested) && v.requested.every((r) => typeof r === 'string');

/** The cached set; null when there is no cache or it is not shaped like one (a damaged file must not crash the page). */
export function readOthersCache(dir: string): OthersCache | null {
  const path = join(dir, OTHERS_CACHE);
  if (!existsSync(path)) return null;
  try {
    const c: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObj(c) || !(c.fetched_at === null || typeof c.fetched_at === 'string') || !Array.isArray(c.prs)) return null;
    const fetchedAt = c.fetched_at === null ? null : new Date(c.fetched_at);
    if ((fetchedAt && !Number.isFinite(fetchedAt.getTime())) || !c.prs.every(isOther)) return null;
    return { fetchedAt, prs: c.prs, ...(typeof c.failure === 'string' && c.failure ? { failure: c.failure } : {}) };
  } catch { return null; }
}

export function writeOthersCache(dir: string, cache: OthersCache): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, OTHERS_CACHE), `${JSON.stringify({ fetched_at: cache.fetchedAt ? cache.fetchedAt.toISOString() : null, ...(cache.failure ? { failure: cache.failure } : {}), prs: cache.prs })}\n`);
}

/**
 * One refresh: read GitHub and store the set. A failed read keeps the last good set, adding the reason and leaving `fetchedAt` where it was, so the
 * tab says how old the list is. Never throws: this rides the page rebuild, which must not fail because teammates' PRs could not be read.
 */
export function refreshOthers(dir: string, scope: OthersScope, now: Date, fetch: (scope: OthersScope, known: readonly OtherPr[]) => OtherPr[] = (sc, known) => fetchOthers(sc, undefined, known, now.getTime())): OthersCache {
  try {
    const cache: OthersCache = { fetchedAt: now, prs: fetch(scope, readOthersCache(dir)?.prs ?? []) };
    writeOthersCache(dir, cache);
    return cache;
  } catch (e) {
    const prev = readOthersCache(dir);
    const failure = (e instanceof Error ? e.message : String(e)).split('\n')[0] || 'unknown error';
    const kept: OthersCache = { fetchedAt: prev?.fetchedAt ?? null, prs: e instanceof PartialOthers ? e.prs : prev?.prs ?? [], failure: e instanceof PartialOthers ? `partial read: ${failure}` : failure };
    try { writeOthersCache(dir, kept); } catch { /* the cache is a convenience: a failed write must not fail the rebuild */ }
    return kept;
  }
}
