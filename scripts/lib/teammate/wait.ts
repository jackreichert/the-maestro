/**
 * Which teammates' PRs have waited long enough for the helper: pure over the GraphQL nodes the pr-watch event type fetches.
 * A PR qualifies when it is open and ready (not a draft), written by someone else (a person, not a bot), in a repo that is not self-review,
 * has no review from a person yet and no decision, and has been ready for review at least `minutes`. It never selects the user's own PR.
 */
import { isSelfReview } from '../self-review.ts';
import { isFormerTeammate } from './former.ts';
import { isIgnored } from './others-actions.ts';

/** Which repos are hands off (`hands_off_repos`, `owner/name` globs) and whose own PRs there stay in scope (`hands_off_owner`, a login). */
export const NO_GUARD: Guard = { globs: [], login: '' };
export interface Guard { globs: readonly string[]; login: string }
/** Another person's PR in a hands-off repo: not reviewed unless the user is asked. The owner's own PRs there are in scope. Nothing is hands off when no repo is configured. */
export const isGuard = (repo: string, author: string, h: Guard): boolean => h.globs.length > 0 && isSelfReview(repo, h.globs) && author.toLowerCase() !== h.login.toLowerCase();

export interface WaitNode {
  number: number; url: string; isDraft: boolean; headRefOid: string; headRefName?: string; baseRefName?: string; createdAt?: string;
  reviewDecision?: string | null;
  reviewRequests?: { nodes: ({ requestedReviewer?: { login?: string } | null } | null)[] };
  author?: { login?: string; __typename?: string } | null;
  repository: { nameWithOwner: string };
  reviews?: { nodes: { author?: { login?: string; __typename?: string } | null; state?: string }[] };
  timelineItems?: { nodes: { createdAt?: string }[] };
}
export interface Waiting { key: string; repo: string; number: number; url: string; head: string; headRef: string; base: string; waitedMin: number }
export interface WaitOptions { self: string; minutes: number; now: number; selfRepos: readonly string[]; guard?: Guard; /** Logins of people who have left (`former_teammates`): never selected. */ former?: readonly string[];
  /** PRs the person ignored (key -> head): left out while the head is the one ignored. */ ignored?: ReadonlyMap<string, string>;
  /** "Review anyway" requests (key -> head): the hands-off guard and the wait minutes do not apply at that head. */ requested?: ReadonlyMap<string, string> }

const isBot = (a: { login?: string; __typename?: string } | null | undefined): boolean => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');

/** When the PR became ready for review: its last ready event, else when it was opened. NaN when neither is readable. */
export function readySince(n: WaitNode): number {
  return Date.parse(n.timelineItems?.nodes[0]?.createdAt ?? n.createdAt ?? '');
}

export function selectWaiting(nodes: readonly WaitNode[], o: WaitOptions): Waiting[] {
  if (!(o.minutes > 0) || !o.self) return [];
  const self = o.self.toLowerCase();
  const out: Waiting[] = [];
  for (const n of nodes) {
    const author = n.author?.login;
    if (n.isDraft || !author || author.toLowerCase() === self || isBot(n.author) || isFormerTeammate(author, o.former)) continue;
    if (isSelfReview(n.repository.nameWithOwner, o.selfRepos)) continue;
    const key = `${n.repository.nameWithOwner}#${n.number}`;
    if (isIgnored(o.ignored ?? new Map(), key, n.headRefOid)) continue;
    const asked = o.requested?.get(key) === n.headRefOid;
    if (!asked && isGuard(n.repository.nameWithOwner, author, o.guard ?? NO_GUARD) && !(n.reviewRequests?.nodes ?? []).some((r) => (r?.requestedReviewer?.login ?? '').toLowerCase() === self)) continue;
    if (n.reviewDecision === 'APPROVED' || n.reviewDecision === 'CHANGES_REQUESTED') continue;
    const reviews = (n.reviews?.nodes ?? []).filter((r) => r.state !== 'PENDING');
    if (reviews.some((r) => (r.author?.login ?? '').toLowerCase() === self || !isBot(r.author))) continue;
    const since = readySince(n);
    if (!Number.isFinite(since)) continue;
    const waitedMin = Math.floor((o.now - since) / 60_000);
    if (waitedMin < o.minutes && !asked) continue;
    out.push({ key, repo: n.repository.nameWithOwner, number: n.number, url: n.url, head: n.headRefOid, headRef: n.headRefName ?? '', base: n.baseRefName ?? '', waitedMin });
  }
  return out;
}

/** The search for other people's open, ready PRs in the given owners. Empty owners means no search at all: never an unscoped one. */
export function teammateSearch(owners: readonly string[]): string | null {
  const safe = owners.filter((o) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(o));
  return safe.length ? `is:pr is:open draft:false -author:@me ${safe.map((o) => `org:${o}`).join(' ')}` : null;
}

export const teammateQuery = (search: string): string => `query($after: String) { search(query: "${search}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number url isDraft createdAt reviewDecision reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } headRefName baseRefName headRefOid author { login __typename } repository { nameWithOwner }
  reviews(last: 20) { nodes { author { login __typename } state } }
  timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }
} } } }`;

/** What is remembered of one waiting PR: the head last seen, when it was first seen, and whether it has been reported. */
export interface HelperEntry { head: string; seen: number; told: boolean }

/**
 * The events for what is waiting, and the record of it (PR key -> entry). A PR is reported once per head. A PR that newly qualifies is reported at
 * once (it has already waited the whole time). A push gives the PR a new head that starts its own wait: it is reported only when that head has stood
 * for `minutes` without a review, so an author pushing every few minutes does not start a review run per push. With no earlier record (the helper
 * was just switched on, or first run) everything waiting is adopted silently, so switching it on does not review every old PR at once.
 */
export function advanceHelper(told: Record<string, HelperEntry> | undefined, waiting: readonly Waiting[], silent: boolean, now: number, minutes: number): { told: Record<string, HelperEntry>; events: { summary: string }[] } {
  const next: Record<string, HelperEntry> = {};
  const events: { summary: string }[] = [];
  const say = (w: Waiting, waited: number): void => { events.push({ summary: `REVIEW-WAIT ${w.key} ${w.url} waiting ${waited} min, head ${w.head.slice(0, 7)}` }); };
  for (const w of waiting) {
    const e = told?.[w.key];
    if (told === undefined || silent) { next[w.key] = { head: w.head, seen: now, told: true }; continue; }
    if (!e) { next[w.key] = { head: w.head, seen: now, told: true }; say(w, w.waitedMin); continue; }
    if (e.head !== w.head) { next[w.key] = { head: w.head, seen: now, told: false }; continue; }
    if (!e.told && now - e.seen >= minutes * 60_000) { next[w.key] = { ...e, told: true }; say(w, Math.floor((now - e.seen) / 60_000)); continue; }
    next[w.key] = e;
  }
  // A PR that is no longer waiting (reviewed, merged, drafted) drops out, so a later wait can speak again.
  return { told: next, events };
}
