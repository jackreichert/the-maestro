/**
 * The Others' PRs tab's data: every open teammate PR the cache holds (`.now-others-prs.json`, written by the status-page rebuild), newest activity first.
 * Reads the cache only, so a page load never reaches GitHub. Own PRs and self-review repos are left out here as well as at fetch time,
 * so a changed `self_review_repos` takes effect before the next rebuild. The review-draft status is joined by the page from the draft queue, which changes on its own.
 */
import { slackActivity } from './slack-activity.ts';
import type { SlackActivity } from './slack-activity.ts';
import { readOthersCache } from '../teammate/others.ts';
import type { Guard } from '../teammate/wait.ts';
import type { OtherPr } from '../teammate/others.ts';
import { isGuard, NO_GUARD } from '../teammate/wait.ts';
import { isSelfReview } from '../self-review.ts';
import { PR_STALE_MS } from './state.ts';
import type { OthersPrRow, OthersPrsData } from '../../web/client/src/types.ts';

const DAY_MS = 86_400_000;

export interface OthersScopeOptions { statusDir: string; owners: readonly string[]; selfRepos: readonly string[]; self: string; guard?: Guard;
  /** A PR whose latest ask (Slack activity, or its own opened time when never posted) is older than this many days is marked stale, unless you are asked for review or @-mentioned. Absent means no cutoff. */
  maxAgeDays?: number;
  /** A PR whose latest ask is older than this many days leaves the tab entirely (Stale included), with the same exemptions as the stale gate: a direct ask or an @-mention is never dropped. Absent means nothing is dropped. */
  dropDays?: number;
  /** The folder of the slack-watch engineering notes (`<vault_root>/Projects/<container>/Slack`); absent means no Slack ask is known. */
  slackDir?: string;
  /** Names that count as @-mentioning you in Slack (`others_prs_mention_names`). */
  mentionNames?: readonly string[] }

const reviewOf = (decision: string | null): OthersPrRow['review'] => (decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes-requested' : 'review-required');

/** Open, nobody asked, nobody looked, and not posted in Slack: pushed but not yet asking for review. Drafts are reported as drafts instead. */
const notAsked = (p: OtherPr, youAsked: boolean, slack: ReadonlyMap<string, SlackActivity>): boolean =>
  p.isDraft === false && !youAsked && p.requested.length === 0 && p.decision === null && p.unresolved === 0 && (p.reviewCount ?? 1) === 0 && !p.yourReview && !slack.has(p.url.toLowerCase());

const CI: Record<string, NonNullable<OthersPrRow['ci']>> = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };
const BLOCK_LABEL = /block|do not merge|don'?t merge|\bwip\b|\bhold\b/i;

/** A review you posted that the author has not pushed after (a commit at or before the review). An approval is not waiting on anything. */
const awaiting = (p: OtherPr): boolean => {
  const r = p.yourReview;
  if (!r || (r.state !== 'COMMENTED' && r.state !== 'CHANGES_REQUESTED') || !p.headAt) return false;
  return Date.parse(p.headAt) <= Date.parse(r.at);
};

function row(p: OtherPr, self: string, guard: Guard, now: Date, slack: ReadonlyMap<string, SlackActivity>, cutoff: number | null): OthersPrRow {
  const opened = Date.parse(p.createdAt);
  const youAsked = self !== '' && p.requested.some((r) => r.toLowerCase() === self.toLowerCase());
  return {
    repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, ...(p.authorName ? { authorName: p.authorName } : {}), base: p.base, updatedAt: p.updatedAt,
    ...(Number.isFinite(opened) ? { ageDays: Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS)) } : {}),
    youAsked, ...(isGuard(p.repo, p.author, guard) && !youAsked ? { handsOff: true } : {}),
    review: reviewOf(p.decision), unresolved: p.unresolved, copilotThreads: p.copilotThreads,
    ...(typeof p.isDraft === 'boolean' ? { isDraft: p.isDraft } : {}),
    ci: (p.ci && Object.hasOwn(CI, p.ci) ? CI[p.ci] : undefined) ?? 'none',
    ...(p.mergeable === 'CONFLICTING' ? { conflicting: true } : {}),
    ...(p.head.startsWith('release/') ? { block: 'release' as const } : (p.labels ?? []).some((l) => BLOCK_LABEL.test(l)) ? { block: 'blocked' as const } : {}),
    ...(awaiting(p) ? { awaitingAuthor: true } : {}),
    ...(notAsked(p, youAsked, slack) ? { notAsked: true } : {}),
    ...ask(p, youAsked, slack, now, cutoff),
  };
}

/**
 * The latest ask for review: the newest Slack post or reply carrying the PR link, or, when it was never posted, the PR's own opening time (GitHub gives no ready or
 * re-request time to this tab). Past the cutoff the PR is stale, unless you are asked for review or @-mentioned: a direct ask never goes stale.
 */
function ask(p: OtherPr, youAsked: boolean, slack: ReadonlyMap<string, SlackActivity>, now: Date, cutoff: number | null): Pick<OthersPrRow, 'askedAt' | 'stale' | 'staleWhy'> {
  const s = slack.get(p.url.toLowerCase());
  const at = latestAskAt(p, s);
  if (!Number.isFinite(at)) return {};
  const days = Math.round((now.getTime() - at) / DAY_MS);
  const stale = pastCutoff(at, cutoff, youAsked, s);
  const why = s ? (s.replied ? `last Slack reply ${days}d ago` : `Slack post ${days}d, no reply`) : `never posted, opened ${days}d ago`;
  return { askedAt: new Date(at).toISOString(), ...(stale ? { stale: true, staleWhy: why } : {}) };
}

/** When the PR was last asked about: its newest Slack post or reply, else the PR's opening time. NaN when neither is a date. */
const latestAskAt = (p: OtherPr, s: SlackActivity | undefined): number => (s ? s.at : Date.parse(p.createdAt));

/** The one rule both gates share: an ask older than the cutoff counts, unless you were asked for review or @-mentioned. */
const pastCutoff = (at: number, cutoff: number | null, youAsked: boolean, s: SlackActivity | undefined): boolean =>
  cutoff !== null && at < cutoff && !youAsked && !s?.mentioned;

/** True when the PR's latest ask is past the drop cutoff and nobody asked you directly. Shares `pastCutoff` with the stale gate, so the two cannot disagree on the clock or the exemptions. */
function dropped(p: OtherPr, self: string, slack: ReadonlyMap<string, SlackActivity>, cutoff: number | null): boolean {
  const youAsked = self !== '' && p.requested.some((r) => r.toLowerCase() === self);
  const s = slack.get(p.url.toLowerCase());
  const at = latestAskAt(p, s);
  return Number.isFinite(at) && pastCutoff(at, cutoff, youAsked, s);
}

export function buildOthersPrs(o: OthersScopeOptions, now: Date): OthersPrsData {
  const cache = readOthersCache(o.statusDir);
  const owners = new Set(o.owners.map((x) => x.toLowerCase()));
  const self = o.self.toLowerCase();
  const slack = slackActivity(o.slackDir, o.mentionNames);
  // Never earlier than the stale gate, so a dropped PR was always stale first.
  const dropCutoff = o.dropDays === undefined ? null : now.getTime() - Math.max(o.dropDays, o.maxAgeDays ?? 0) * DAY_MS;
  const kept = (cache?.prs ?? [])
    .filter((p) => p.author.toLowerCase() !== self && owners.has((p.repo.split('/')[0] ?? '').toLowerCase()) && !isSelfReview(p.repo, o.selfRepos))
    .filter((p) => !dropped(p, self, slack, dropCutoff))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cutoff = o.maxAgeDays === undefined ? null : now.getTime() - o.maxAgeDays * DAY_MS;
  const fetchedAt = cache?.fetchedAt ?? null;
  const stale = !fetchedAt || now.getTime() - fetchedAt.getTime() > PR_STALE_MS;
  return {
    generatedAt: now.toISOString(),
    prData: { fetchedAt: fetchedAt ? fetchedAt.toISOString() : null, stale, ...(cache?.failure ? { failure: cache.failure } : {}) },
    total: kept.length, prs: kept.map((p) => row(p, o.self, o.guard ?? NO_GUARD, now, slack, cutoff)),
  };
}
