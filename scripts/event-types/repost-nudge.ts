/**
 * repost-nudge: tells the orchestrator when the user should repost their PRs in Slack to get them reviewed, with no model involved.
 * Target is the status directory (any existing directory), one watch; session-start.ts registers it.
 *
 * Two triggers (the rules are in lib/repost-nudge.ts): `repost_nudge_minutes` (default 60) after the latest APPROVED review on any of the
 * user's open PRs, read from the same GitHub search pr-watch uses; and a teammate review draft queued or posted, read from the draft queue
 * (drafts.jsonl: a `review`-source `add` row, or the `posted` row of one). Only on weekdays between repost_nudge_start and repost_nudge_end,
 * at most one an hour, and none within repost_nudge_asked_minutes (default 60) of the user asking for reviews themselves: a Slack line by them with a PR link
 * (the notes slack-watch keeps, lib/repost-nudge-slack.ts) or a review re-request they made on GitHub. One due outside the hours, or inside that window, is held until it opens. The nudge names up to `repost_nudge_count` PRs waiting on reviewers,
 * oldest first, with a paste-ready Slack line. It is an actionable event: the orchestrator raises it as a Needs-you ask (the playbook).
 * A failed GitHub read throws, so the loop keeps the last state and tries again next tick. Off with repost_nudge_minutes 0.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, GH_LOGIN, LEDGER_ROOT, PR_SEARCH, REPOST_NUDGE_ASKED_MINUTES, REPOST_NUDGE_AUTHOR, REPOST_NUDGE_CHECK_SECONDS, REPOST_NUDGE_COUNT, REPOST_NUDGE_DAYS, REPOST_NUDGE_ENABLED, REPOST_NUDGE_END, REPOST_NUDGE_GAP_MINUTES, REPOST_NUDGE_HOLD_EMPTY, REPOST_NUDGE_MINUTES, REPOST_NUDGE_REPOS, REPOST_NUDGE_START, REPOST_NUDGE_TRIGGERS, REPOST_NUDGE_TZ, REVIEW_QUEUE_ORGS, SELF_REVIEW_REPOS, VAULT_ROOT } from '../local-config.ts';
import { isBotLogin } from '../lib/github-bots.ts';
import { draftsPath, readRows } from '../lib/drafts/queue.ts';
import { actionsPath, isIgnored, readIgnored } from '../lib/teammate/others-actions.ts';
import { searchAllPages } from '../lib/gh-search.ts';
import { latestAskInDir } from '../lib/repost-nudge-slack.ts';
import { advance, approvalTime, HOUR_MS, nudgeLine, nudgeOn } from '../lib/repost-nudge.ts';
import type { NudgePr, NudgeSettings, NudgeState } from '../lib/repost-nudge.ts';
import type { CheckContext, Run, WatchEvent } from '../lib/types.ts';

export const interval = REPOST_NUDGE_CHECK_SECONDS;
export const renews = true;
export const network = true;
export const singleton = true;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`repost-nudge target must be an existing directory (use the status directory), got "${target}"`);
}

/** What the check reads from the outside world; tests replace it. */
export interface NudgeIo {
  /** The user's open PRs; throws when GitHub cannot be read, so a bad read is never taken for "no PRs". */
  fetchPrs(run: Run): NudgePr[];
  /** When the latest teammate review draft was queued or posted (epoch ms), 0 for none. */
  latestDraftAt(): number;
  /** When the user last asked for reviews in Slack (epoch ms), 0 for none. */
  latestSlackAskAt(now: number): number;
}

interface Node {
  number: number; url: string; isDraft: boolean; createdAt?: string; reviewDecision?: string | null; mergeable?: string | null;
  repository: { nameWithOwner: string };
  latestReviews?: { nodes: { state?: string; submittedAt?: string | null }[] };
  reviewThreads?: { nodes: { isResolved: boolean }[] };
  timelineItems?: { nodes: { createdAt?: string }[] };
  requests?: { nodes: { createdAt?: string; actor?: { login?: string } | null; requestedReviewer?: { __typename?: string; login?: string } | null }[] };
}

export const QUERY = `query($after: String) { search(query: "${PR_SEARCH}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number url isDraft createdAt reviewDecision mergeable repository { nameWithOwner }
  latestReviews(first: 20) { nodes { state submittedAt } }
  reviewThreads(first: 100) { nodes { isResolved } }
  timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }
  requests: timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } } } } }
} } } }`;

/** One search node as the nudge reads it. */
export function toPr(n: Node, me = ''): NudgePr {
  const mine = (n.requests?.nodes ?? []).filter((r) => me && (r.actor?.login ?? '').toLowerCase() === me.toLowerCase() && r.requestedReviewer?.__typename === 'User' && !isBotLogin(r.requestedReviewer.login ?? '')).map((r) => Date.parse(r.createdAt ?? '')).filter(Number.isFinite);
  const approvals = (n.latestReviews?.nodes ?? []).filter((r) => r.state === 'APPROVED').map((r) => Date.parse(r.submittedAt ?? '')).filter(Number.isFinite);
  return {
    repo: n.repository.nameWithOwner, number: n.number, url: n.url, isDraft: n.isDraft,
    reviewDecision: n.reviewDecision ?? null, mergeable: n.mergeable ?? null,
    unresolvedThreads: (n.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    readySince: Date.parse(n.timelineItems?.nodes[0]?.createdAt ?? n.createdAt ?? ''),
    approvedAt: approvals.length ? Math.max(...approvals) : Number.NaN,
    rerequestedAt: mine.length ? Math.max(...mine) : Number.NaN,
  };
}

const slackDir = (): string => join(VAULT_ROOT, 'Projects', CONFIGURED_PROJECT || CONTAINER_PROJECT, 'Slack');
const draftsFile = (): string => draftsPath(LEDGER_ROOT || VAULT_ROOT, CONFIGURED_PROJECT || CONTAINER_PROJECT);

/** The newest time a teammate review draft (a `review`-source draft) was queued or posted in the queue file; 0 for none or an unreadable file. */
export function latestReviewDraftAt(file: string, ignored: ReadonlyMap<string, string> = new Map()): number {
  let rows;
  try { rows = readRows(file); } catch { return 0; }
  // A draft on a PR the person ignored (at the head it was written for) is not a review we did, so it starts no nudge.
  const review = new Set(rows.flatMap((r) => (r.op === 'add' && r.source === 'review' && !(r.target.kind === 'review' && isIgnored(ignored, `${r.repo}#${r.pr}`, r.target.commitId)) ? [r.id] : [])));
  const times = rows.filter((r) => (r.op === 'add' || r.op === 'posted') && review.has(r.id)).map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

export const realIo: NudgeIo = {
  fetchPrs: (run) => (PR_SEARCH.includes('user:') || PR_SEARCH.includes('org:') ? searchAllPages<Node>(QUERY, run).map((n) => toPr(n, GH_LOGIN)) : []),
  latestSlackAskAt: (now) => (VAULT_ROOT ? latestAskInDir(slackDir(), REPOST_NUDGE_AUTHOR, REVIEW_QUEUE_ORGS, now, 2 * 24 * HOUR_MS) : 0),
  latestDraftAt: () => latestReviewDraftAt(draftsFile(), readIgnored(actionsPath(LEDGER_ROOT || VAULT_ROOT, CONFIGURED_PROJECT || CONTAINER_PROJECT))),
};

const settings = (): NudgeSettings => ({ enabled: REPOST_NUDGE_ENABLED, triggers: REPOST_NUDGE_TRIGGERS, minutes: REPOST_NUDGE_MINUTES, askedMinutes: REPOST_NUDGE_ASKED_MINUTES, gapMinutes: REPOST_NUDGE_GAP_MINUTES, count: REPOST_NUDGE_COUNT, start: REPOST_NUDGE_START, end: REPOST_NUDGE_END, zone: REPOST_NUDGE_TZ, days: REPOST_NUDGE_DAYS, repos: REPOST_NUDGE_REPOS, holdEmpty: REPOST_NUDGE_HOLD_EMPTY, selfReview: SELF_REVIEW_REPOS, owners: REVIEW_QUEUE_ORGS });

export function check(_target: string, ctx: Pick<CheckContext, 'now' | 'prev' | 'run'>, io: NudgeIo = realIo, s: NudgeSettings = settings()): NudgeState {
  const prev = (ctx.prev as NudgeState | null | undefined) ?? null;
  if (!nudgeOn(s)) return advance(prev, { approvedAt: 0, draftAt: io.latestDraftAt() }, [], ctx.now, s);
  const prs = io.fetchPrs(ctx.run);
  const approvedAt = approvalTime(prs, s);
  const askedAt = Math.max(io.latestSlackAskAt(ctx.now), ...prs.map((p) => p.rerequestedAt).filter(Number.isFinite));
  return advance(prev, { approvedAt, draftAt: io.latestDraftAt(), askedAt }, prs, ctx.now, s);
}

/** One actionable line each time the state raised a nudge since the last check. */
export function diff(prev: NudgeState | null, next: NudgeState): WatchEvent[] {
  if (next.emitSeq <= (prev?.emitSeq ?? 0) || !next.nudge) return [];
  return [{ summary: nudgeLine(next.nudge), actionable: true }];
}
