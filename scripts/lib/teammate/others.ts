/**
 * The listed teammate PRs, for the Podium's Others' PRs tab. Only PRs on the opt-in list (lib/teammate/others-list.ts) are read from GitHub, by key in small
 * batches (lib/gh-search.ts `readPullRequests`); there is no search across every open teammate PR. The result is reduced to the fields the tab shows and
 * remembered in `<statusDir>/.now-others-prs.json`. The status-page rebuild (the loop's status-refresh cadence, and the Open PRs Refresh button) writes it;
 * the web server only reads it, so a page load never reaches GitHub. A failed read keeps the last good set and records why.
 *
 * A refresh does four things, in order: it joins PRs to the list (a Slack review ask, a GitHub review request or @-mention of you, a staging twin, a backmerge
 * or a P0/hotfix PR; hand adds and the migration seed are written straight to the list), reads the listed PRs, drops the ones that no longer need you
 * (merged, closed, approved, picked up by another reviewer or claimed in Slack, or quiet for two working days: lib/teammate/settled.ts and others-drop.ts), and
 * writes what is left. Own PRs, bots and self-review repos never stay on the list; drafts are kept and flagged. Threads and requested reviewers are read from the first 100 and 20, so larger counts are capped.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBotAuthor } from '../github-bots.ts';
import { readPullRequests, searchPagesPartial } from '../gh-search.ts';
import { isSelfReview } from '../self-review.ts';
import { isFormerTeammate } from './former.ts';
import { settledReason } from './settled.ts';
import type { SettledReview } from './settled.ts';
import { writeAtomic } from '../status-page/seen.ts';
import { droppedForQuiet, lastActivity } from './others-drop.ts';
import type { DropGate } from './others-drop.ts';
import { addToList, compactList, dropFromList, listKey, listPath, mayRejoin, readList } from './others-list.ts';
import type { JoinSource } from './others-list.ts';
import { scanSlack } from './others-slack.ts';
import { workingMs } from './working-time.ts';
import type { Run } from '../types.ts';

export const OTHERS_CACHE = '.now-others-prs.json';

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
}
export interface OthersCache { fetchedAt: Date | null; failure?: string; prs: OtherPr[] }
export interface OthersScope { owners: readonly string[]; selfRepos: readonly string[]; self: string; /** Logins of people who have left (`former_teammates`); their PRs are dropped. */ former?: readonly string[];
  /** The quiet-drop gate (lib/teammate/others-drop.ts): the time zone, and the open, active and drop windows. */
  gate: DropGate;
  /** The folder of the slack-watch engineering notes (`<vault_root>/Projects/<container>/Slack`); absent means no Slack ask is read. */
  slackDir?: string;
  /** Your display names in Slack, so a reply by you is never read as a teammate claiming the PR. */
  selfNames?: readonly string[];
  /** PRs to put on the list when there is no list yet (the migration): the ones with a review draft waiting. */
  seedKeys?: readonly string[] }

interface Login { login?: string; __typename?: string; name?: string | null }
interface Node {
  id?: string; number?: number; title?: string; url?: string; state?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string; baseRefName?: string; headRefName?: string; headRefOid?: string;
  reviewDecision?: string | null; mergeable?: string; author?: Login | null;
  labels?: { nodes?: ({ name?: string } | null)[] };
  reviews?: { nodes?: ({ author?: Login | null; state?: string; submittedAt?: string; bodyText?: string } | null)[] };
  commits?: { nodes?: ({ commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null } } | null)[] }; repository?: { nameWithOwner?: string };
  reviewRequests?: { nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[] };
  reviewThreads?: { nodes?: ({ isResolved?: boolean; comments?: { nodes?: ({ author?: Login | null } | null)[] } } | null)[] };
}

/** What is read of each listed PR. Threads carry their first comment's author, so the Copilot ones can be counted; ten PRs a call keeps that small (lib/gh-search.ts). */
export const PR_SELECTION = `id number title url state isDraft createdAt updatedAt baseRefName headRefName headRefOid reviewDecision mergeable author { login __typename ... on User { name } } repository { nameWithOwner }
  labels(first: 10) { nodes { name } }
  reviews(last: 30) { nodes { author { login __typename } state submittedAt bodyText } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login __typename } } } } }`;

const isCopilot = (a: Login | null | undefined): boolean => /copilot/i.test(a?.login ?? '');

/** A PR node's submitted reviews in the classifier's shape (lib/teammate/settled.ts); a review with no author is a deleted account, never a bot. */
const settledReviews = (n: Node): SettledReview[] => (n.reviews?.nodes ?? []).flatMap((r) => (r?.state && r.submittedAt ? [{ login: r.author?.login ?? '', bot: isBotAuthor(r.author), state: r.state, at: r.submittedAt, body: r.bodyText ?? '' }] : []));

/** What judging one listed PR decides: keep it (reduced), drop it with a reason (and the `updatedAt` it was judged at), or skip it when GitHub's node is not shaped like a PR (it stays as it was). */
export type Judgement = { pr: OtherPr } | { drop: string; updatedAt?: string } | { skip: true };
/** When judging for the list: the time, the day the PR was listed (the ask is its first sign of life) and a Slack claim made after the ask. */
export interface JudgeContext { now: number; listedAt?: number; claimedAt?: number }

/** One listed PR's node, judged. Not yours to review here, settled (merged, closed, approved, picked up: lib/teammate/settled.ts), claimed in Slack, or quiet for two working days drops it. */
export function judgeNode(n: Node, scope: OthersScope, ctx?: JudgeContext): Judgement {
  const self = scope.self.toLowerCase();
  const updatedAt = n.updatedAt ?? n.createdAt;
  const repo = n.repository?.nameWithOwner;
  const author = n.author?.login;
  if (!repo || !author || typeof n.number !== 'number' || !n.url || typeof n.isDraft !== 'boolean') return { skip: true };
  if (isBotAuthor(n.author) || (self !== '' && author.toLowerCase() === self) || isSelfReview(repo, scope.selfRepos) || isFormerTeammate(author, scope.former) || !scope.owners.some((o) => o.toLowerCase() === repo.split('/')[0]?.toLowerCase())) return { drop: 'not yours to review here: your own PR, a bot, a self-review repo, a former teammate or another owner', updatedAt };
  const mine = (n.reviews?.nodes ?? []).filter((r) => r && r.state && r.state !== 'PENDING' && r.submittedAt && self !== '' && (r.author?.login ?? '').toLowerCase() === self).sort((a, b) => (a?.submittedAt ?? '').localeCompare(b?.submittedAt ?? '')).pop();
  const head = n.commits?.nodes?.[0]?.commit;
  const settled = settledReason({ state: n.state === 'MERGED' || n.state === 'CLOSED' ? n.state : 'OPEN', decision: n.reviewDecision ?? null, author, self: scope.self, createdAt: n.createdAt ?? '', ...(head?.committedDate ? { headAt: head.committedDate } : {}),
    requested: (n.reviewRequests?.nodes ?? []).map((r) => r?.requestedReviewer?.login).filter((l): l is string => !!l), reviews: settledReviews(n) });
  if (settled) return { drop: settled.text, updatedAt };
  const open = (n.reviewThreads?.nodes ?? []).filter((t) => t && t.isResolved === false);
  const pr: OtherPr = {
    repo, number: n.number, title: n.title ?? '', url: n.url, author, ...(n.author?.name?.trim() ? { authorName: n.author.name.trim().slice(0, 80) } : {}), base: n.baseRefName ?? '', head: n.headRefName ?? '', ...(typeof n.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(n.headRefOid) ? { headSha: n.headRefOid } : {}),
    createdAt: n.createdAt ?? '', updatedAt: n.updatedAt ?? n.createdAt ?? '',
    requested: (n.reviewRequests?.nodes ?? []).map((r) => r?.requestedReviewer?.login).filter((l): l is string => !!l),
    decision: n.reviewDecision ?? null, unresolved: open.length, copilotThreads: open.filter((t) => isCopilot(t?.comments?.nodes?.[0]?.author)).length,
    isDraft: n.isDraft, ...(head?.statusCheckRollup?.state ? { ci: head.statusCheckRollup.state } : {}), ...(n.mergeable ? { mergeable: n.mergeable } : {}),
    labels: (n.labels?.nodes ?? []).map((l) => l?.name ?? '').filter(Boolean).slice(0, 10),
    ...(mine?.state && mine.submittedAt ? { yourReview: { state: mine.state, at: mine.submittedAt } } : {}), ...(head?.committedDate ? { headAt: head.committedDate } : {}),
    reviewCount: (n.reviews?.nodes ?? []).filter((r) => r && r.state && r.state !== 'PENDING').length,
  };
  if (ctx) {
    const asked = pr.requested.some((r) => r.toLowerCase() === self) && !pr.yourReview;
    if (ctx.claimedAt !== undefined && !asked) return { drop: 'a teammate claimed it in Slack', updatedAt };
    if (droppedForQuiet(pr, lastActivity(pr.updatedAt, pr.createdAt, ctx.listedAt), ctx.now, scope.gate)) return { drop: 'no push, comment or review for two working days', updatedAt };
  }
  return { pr };
}

/** The listed nodes worth showing, reduced (the settled and out-of-scope ones left out), newest activity first. */
export function reduceOthers(nodes: readonly Node[], scope: OthersScope): OtherPr[] {
  const out: OtherPr[] = [];
  for (const n of nodes) { const j = judgeNode(n, scope); if ('pr' in j) out.push(j.pr); }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** What a discovery search reads of a PR: enough to classify and to scope it, nothing nested but the labels. */
const DISCOVERY_SELECTION = 'number url updatedAt isDraft headRefName baseRefName author { login __typename } repository { nameWithOwner } labels(first: 10) { nodes { name } }';
const discoveryQuery = (search: string): string => `query($after: String) { search(query: "${search}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${DISCOVERY_SELECTION} } } } }`;

interface FoundNode { number?: number; url?: string; updatedAt?: string; headRefName?: string; baseRefName?: string; author?: Login | null; repository?: { nameWithOwner?: string }; labels?: { nodes?: ({ name?: string } | null)[] } }
export interface Found { key: string; source: JoinSource; updatedAt?: string }

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** The discovery searches: PRs asking for you (a review request, an @-mention), and the kinds that skip the wait (staging-bound PRs, P0 and hotfix labels). Each is scoped to the owners and to one narrow qualifier; none is a search of every open PR. */
export function discoverySearches(owners: readonly string[]): { source: 'review-request' | 'mention' | 'special'; search: string }[] {
  const safe = owners.filter((o) => SAFE_OWNER.test(o));
  if (!safe.length) return [];
  const base = `is:pr is:open archived:false -author:@me ${safe.map((o) => `user:${o}`).join(' ')}`;
  return [{ source: 'review-request', search: `${base} review-requested:@me` }, { source: 'mention', search: `${base} mentions:@me` },
    { source: 'special', search: `${base} base:staging` }, { source: 'special', search: `${base} label:p0,hotfix` }];
}

const BACKMERGE = /^(backmerge\/|back-merge-)/i;
const HOTFIX = /^(hotfix|p0)[/-]/i;
/** What kind of special PR this is, from its branches and labels, or null when it is none: a backmerge, a hotfix or P0, or a staging twin (headed into staging from a feature branch). */
export function specialKind(n: FoundNode): 'backmerge' | 'hotfix' | 'twin' | null {
  const head = n.headRefName ?? '';
  if (BACKMERGE.test(head)) return 'backmerge';
  if (HOTFIX.test(head) || (n.labels?.nodes ?? []).some((l) => /^(p0|hotfix)$/i.test(l?.name ?? ''))) return 'hotfix';
  if ((n.baseRefName ?? '').toLowerCase() === 'staging' && !/^(release\/|staging$|develop$|main$)/i.test(head)) return 'twin';
  return null;
}

/** The PRs the discovery searches find, scoped (not yours, not a bot, not a self-review repo or former teammate, an owner you review for) and sorted into the route that found them. A search that fails is reported in `errors` and adds nothing. */
export function discover(scope: OthersScope, run?: Run): { found: Found[]; errors: string[] } {
  const found = new Map<string, Found>();
  const errors: string[] = [];
  const self = scope.self.toLowerCase();
  for (const { source, search } of discoverySearches(scope.owners)) {
    let nodes: FoundNode[];
    try { const r = searchPagesPartial<FoundNode>(discoveryQuery(search), run); nodes = r.nodes; if (r.error) errors.push(r.error.message); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); continue; }
    for (const n of nodes) {
      const repo = n.repository?.nameWithOwner;
      const author = n.author?.login;
      if (!repo || !author || typeof n.number !== 'number') continue;
      if (isBotAuthor(n.author) || (self !== '' && author.toLowerCase() === self) || isSelfReview(repo, scope.selfRepos) || isFormerTeammate(author, scope.former)) continue;
      if (!scope.owners.some((o) => o.toLowerCase() === repo.split('/')[0]?.toLowerCase())) continue;
      const kind = source === 'special' ? specialKind(n) : source;
      if (!kind) continue;
      const key = listKey(`${repo}#${n.number}`);
      if (!found.has(key)) found.set(key, { key, source: kind, ...(n.updatedAt ? { updatedAt: n.updatedAt } : {}) });
    }
  }
  return { found: [...found.values()], errors: errors.map((e) => e.split('\n')[0] ?? 'error') };
}

/** Puts new asks on the list: Slack review asks still inside the drop window, and what the discovery found, each only if the list has no news to the contrary (`mayRejoin`). Returns the Slack claims by key. */
function joinList(file: string, scope: OthersScope, now: number, run: Run | undefined, failures: string[]): Map<string, number> {
  const claims = new Map<string, number>();
  const slack = scanSlack(scope.slackDir, { owners: scope.owners, ...(scope.selfNames ? { selfNames: scope.selfNames } : {}) });
  for (const c of slack.claims) claims.set(c.key, Math.max(claims.get(c.key) ?? 0, c.at));
  const window = scope.gate.drop === null ? Number.POSITIVE_INFINITY : Math.max(scope.gate.drop, scope.gate.active ?? 0);
  for (const ask of slack.asks) {
    if (workingMs(ask.at, now, scope.gate.tz) > window) continue;
    if (mayRejoin(readList(file), ask.key, { askedAt: ask.at })) addToList(file, { key: ask.key, source: 'slack', at: ask.at, channel: ask.channel, ...(ask.author ? { author: ask.author } : {}) }, now);
  }
  const d = discover(scope, run);
  if (d.errors.length) failures.push(`discovery: ${d.errors[0]}`);
  for (const f of d.found) if (mayRejoin(readList(file), f.key, f.updatedAt ? { updatedAt: f.updatedAt } : {})) addToList(file, { key: f.key, source: f.source }, now);
  return claims;
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
 * One refresh: join, read the listed PRs, drop the ones that no longer need you, store what is left. A failed read keeps the last good set, adding the reason and
 * leaving `fetchedAt` where it was, so the tab says how old the list is; a PR whose batch failed keeps its last stored card and stays on the list. A failed discovery
 * search costs only that search (the tab still refreshes and the failure is noted). Never throws: this rides the page rebuild, which must not fail because teammates' PRs could not be read.
 */
export function refreshOthers(dir: string, scope: OthersScope, now: Date, run?: Run): OthersCache {
  const nowMs = now.getTime();
  const prev = readOthersCache(dir);
  try {
    const file = listPath(dir);
    const failures: string[] = [];
    if (!existsSync(file)) for (const key of (scope.seedKeys ?? []).filter((k) => scope.owners.some((o) => o.toLowerCase() === (k.split('/')[0] ?? '')))) { try { addToList(file, { key, source: 'seed' }, nowMs); } catch { /* a draft's key that is not a PR key is not seeded */ } }
    const claims = joinList(file, scope, nowMs, run, failures);
    const listed = [...readList(file).active.values()];
    const read = readPullRequests<Node>(listed.map((e) => e.key), PR_SELECTION, run);
    const prs: OtherPr[] = [];
    for (const e of listed) {
      const node = read.nodes.get(e.key);
      if (!node) {
        if (read.gone.includes(e.key)) dropFromList(file, e.key, 'GitHub no longer shows this PR', undefined, nowMs);
        else { const old = prev?.prs.find((p) => listKey(`${p.repo}#${p.number}`) === e.key); if (old) prs.push(old); }
        continue;
      }
      const claimed = claims.get(e.key);
      const j = judgeNode(node, scope, { now: nowMs, listedAt: e.at, ...(claimed !== undefined && claimed > e.at ? { claimedAt: claimed } : {}) });
      if ('pr' in j) prs.push(j.pr);
      else if ('drop' in j) dropFromList(file, e.key, j.drop, j.updatedAt, nowMs);
    }
    try { compactList(file, nowMs); } catch { /* the file is only ever folded: a failed compaction changes nothing a reader sees */ }
    const partial = read.error ? `partial read: ${read.error.message.split('\n')[0]}` : '';
    const cache: OthersCache = { fetchedAt: read.error ? prev?.fetchedAt ?? null : now, prs: prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), ...([partial, ...failures].filter(Boolean).length ? { failure: [partial, ...failures].filter(Boolean).join('; ') } : {}) };
    writeOthersCache(dir, cache);
    return cache;
  } catch (e) {
    const failure = (e instanceof Error ? e.message : String(e)).split('\n')[0] || 'unknown error';
    const kept: OthersCache = { fetchedAt: prev?.fetchedAt ?? null, prs: prev?.prs ?? [], failure };
    try { writeOthersCache(dir, kept); } catch { /* the cache is a convenience: a failed write must not fail the rebuild */ }
    return kept;
  }
}
