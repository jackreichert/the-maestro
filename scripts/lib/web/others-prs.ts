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
import { isFormerTeammate } from '../teammate/former.ts';
import { PR_STALE_MS } from './state.ts';
import type { OthersPrRow, OthersPrsData } from '../../web/client/src/types.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface OthersScopeOptions { statusDir: string; owners: readonly string[]; selfRepos: readonly string[]; self: string; guard?: Guard;
  /** Logins of people who have left (`former_teammates`): a PR by one leaves the tab whatever the cache holds. */
  former?: readonly string[];
  /** A PR opened less than this many hours ago is never stale or dropped. Absent (with `activeHours`) means no staleness gate. */
  openHours?: number;
  /** A PR opened longer ago is active only with activity in the last this many hours; otherwise it is stale. */
  activeHours?: number;
  /** A PR with no activity for more than this many days (and past `openHours`) leaves the tab entirely, Stale included. Never below the stale gate. Absent means nothing is dropped. */
  dropDays?: number;
  /** The folder of the slack-watch engineering notes (`<vault_root>/Projects/<container>/Slack`); absent means no Slack ask is known. */
  slackDir?: string }

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

function row(p: OtherPr, self: string, guard: Guard, now: Date, slack: ReadonlyMap<string, SlackActivity>, gate: Gate): OthersPrRow {
  const opened = Date.parse(p.createdAt);
  const youAsked = self !== '' && p.requested.some((r) => r.toLowerCase() === self.toLowerCase());
  return {
    repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, ...(p.authorName ? { authorName: p.authorName } : {}), base: p.base, updatedAt: p.updatedAt,
    ...(Number.isFinite(opened) ? { openedAt: new Date(opened).toISOString(), ageDays: Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS)) } : {}),
    youAsked, ...(isGuard(p.repo, p.author, guard) && !youAsked ? { handsOff: true } : {}),
    review: reviewOf(p.decision), unresolved: p.unresolved, copilotThreads: p.copilotThreads,
    ...(typeof p.isDraft === 'boolean' ? { isDraft: p.isDraft } : {}),
    ci: (p.ci && Object.hasOwn(CI, p.ci) ? CI[p.ci] : undefined) ?? 'none',
    ...(p.mergeable === 'CONFLICTING' ? { conflicting: true } : {}),
    ...(p.head.startsWith('release/') ? { block: 'release' as const } : (p.labels ?? []).some((l) => BLOCK_LABEL.test(l)) ? { block: 'blocked' as const } : {}),
    ...(awaiting(p) ? { awaitingAuthor: true } : {}),
    ...(notAsked(p, youAsked, slack) ? { notAsked: true } : {}),
    ...ask(p, slack, now, gate),
  };
}

/**
 * The latest ask for review (`askedAt`): the newest Slack post or reply carrying the PR link, or, when it was never posted, the PR's own opening time.
 * Whether the PR is stale is a separate question, answered by `lapsed` from its activity.
 */
function ask(p: OtherPr, slack: ReadonlyMap<string, SlackActivity>, now: Date, gate: Gate): Pick<OthersPrRow, 'askedAt' | 'stale' | 'staleWhy'> {
  const s = slack.get(p.url.toLowerCase());
  const at = s ? s.at : Date.parse(p.createdAt);
  if (!Number.isFinite(at)) return {};
  const last = lastActivityAt(p, s);
  const why = lapsed(p, last, now, gate) ? `no activity for ${span(now.getTime() - last)}, opened ${span(now.getTime() - Date.parse(p.createdAt))} ago` : null;
  return { askedAt: new Date(at).toISOString(), ...(why ? { stale: true, staleWhy: why } : {}) };
}

/** The staleness thresholds in milliseconds; a null gate disables that check. */
interface Gate { open: number | null; active: number | null; drop: number | null }

/** The newest sign of life: a push, review, comment or re-request (GitHub's updatedAt), or a Slack post or reply carrying the link. NaN when neither is a date. */
const lastActivityAt = (p: OtherPr, s: SlackActivity | undefined): number => Math.max(Date.parse(p.updatedAt) || 0, s?.at ?? 0, Date.parse(p.createdAt) || 0) || Number.NaN;

/** Hours under three days, days beyond ("5 h", "30 h", "4 d"), matching what the tab shows. */
const span = (ms: number): string => (ms < 3 * DAY_MS ? `${Math.max(0, Math.floor(ms / HOUR_MS))} h` : `${Math.floor(ms / DAY_MS)} d`);

/** Opened inside the open window: too new to be stale whatever its activity. */
const young = (p: OtherPr, now: Date, gate: Gate): boolean => gate.open !== null && now.getTime() - Date.parse(p.createdAt) < gate.open;

/** True when the PR is neither young nor active: no push, review, comment, re-request or Slack mention inside the active window. A request for you is activity like any other, not an exemption. */
function lapsed(p: OtherPr, last: number, now: Date, gate: Gate): boolean {
  if (gate.active === null || !Number.isFinite(last) || young(p, now, gate)) return false;
  return now.getTime() - last >= gate.active;
}

/** True when the PR has had no activity for longer than the drop window (never shorter than the active window) and is past the open window. */
function dropped(p: OtherPr, slack: ReadonlyMap<string, SlackActivity>, now: Date, gate: Gate): boolean {
  if (gate.drop === null || young(p, now, gate)) return false;
  const last = lastActivityAt(p, slack.get(p.url.toLowerCase()));
  return Number.isFinite(last) && now.getTime() - last > Math.max(gate.drop, gate.active ?? 0);
}

export function buildOthersPrs(o: OthersScopeOptions, now: Date): OthersPrsData {
  const cache = readOthersCache(o.statusDir);
  const owners = new Set(o.owners.map((x) => x.toLowerCase()));
  const self = o.self.toLowerCase();
  const slack = slackActivity(o.slackDir);
  const gate: Gate = { open: o.openHours === undefined ? null : o.openHours * HOUR_MS, active: o.activeHours === undefined ? null : o.activeHours * HOUR_MS, drop: o.dropDays === undefined ? null : o.dropDays * DAY_MS };
  const approved = (cache?.prs ?? []).filter((p) => p.decision === 'APPROVED');
  const kept = (cache?.prs ?? [])
    .filter((p) => p.decision !== 'APPROVED')
    .filter((p) => p.author.toLowerCase() !== self && owners.has((p.repo.split('/')[0] ?? '').toLowerCase()) && !isSelfReview(p.repo, o.selfRepos) && !isFormerTeammate(p.author, o.former))
    .filter((p) => !dropped(p, slack, now, gate))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const fetchedAt = cache?.fetchedAt ?? null;
  const stale = !fetchedAt || now.getTime() - fetchedAt.getTime() > PR_STALE_MS;
  return {
    generatedAt: now.toISOString(),
    prData: { fetchedAt: fetchedAt ? fetchedAt.toISOString() : null, stale, ...(cache?.failure ? { failure: cache.failure } : {}) },
    total: kept.length, approvedKeys: approved.map((p) => `${p.repo}#${p.number}`), prs: kept.map((p) => row(p, o.self, o.guard ?? NO_GUARD, now, slack, gate)),
  };
}
