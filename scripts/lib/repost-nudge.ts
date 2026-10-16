/**
 * The repost nudge, pure: when the user should be nudged to repost their PRs in Slack, and which PRs to name.
 * Two triggers feed it: an approval on one of the user's open PRs (the nudge is due `minutes` later) and a teammate review draft
 * queued or posted (due at once). A due nudge goes out only in working hours (the configured days between start and end, in a zone), at most one
 * per gap (`gapMinutes`); a nudge due outside them is held, and one is sent when the hours open. Reads no clock, no config and no network:
 * event-types/repost-nudge.ts hands it the PRs, the trigger times and the settings.
 */
import { isSelfReview } from './self-review.ts';
import { inQueueOwners } from './review-queue.ts';
import { localParts } from './recurring-time.ts';
import { clockMinutes, DEFAULT_DAYS } from './repost-nudge-config.ts';
import type { Trigger } from './repost-nudge-config.ts';

export const HOUR_MS = 3600_000;

/** One of the user's open PRs, reduced to what the nudge reads. Times are epoch ms; NaN when unknown. */
export interface NudgePr {
  repo: string; number: number; url: string; isDraft: boolean;
  reviewDecision: string | null; mergeable: string | null;
  unresolvedThreads: number;
  /** When the PR became ready for review (opened, or last marked ready). */
  readySince: number;
  /** The latest APPROVED review on it, or NaN when it has none. */
  approvedAt: number;
  /** The latest time the user re-requested a review on it, or NaN. */
  rerequestedAt: number;
}

export interface NudgeSettings {
  enabled: boolean; triggers: readonly Trigger[];
  minutes: number; askedMinutes: number; gapMinutes: number; count: number;
  start: string; end: string; zone: string; days: readonly number[];
  /** `repost_nudge_repos`: when not empty, the only repos whose approvals count and whose PRs are named. */
  repos: readonly string[];
  /** Hold a due nudge with no eligible PR (up to a day) instead of dropping it. */
  holdEmpty: boolean;
  selfReview: readonly string[]; owners: readonly string[];
}

/** How long a due nudge with nobody to name is held when `holdEmpty` is on; after that it is dropped even if a PR turns up. */
export const HOLD_EMPTY_MAX_MS = 24 * HOUR_MS;

/** What the loop remembers between checks. Times are epoch ms; 0 means never. */
export interface NudgeState {
  /** Latest approval and latest teammate-draft time seen, and how much of each a nudge has already answered. */
  approvedAt: number; approvedHandled: number; draftAt: number; draftHandled: number;
  lastNudgeAt: number; emitSeq: number;
  /** When a due nudge was first held for want of an eligible PR (`holdEmpty`), 0 when none is. */
  emptyHeldSince: number;
  /** The nudge raised by the latest emit; empty before the first. */
  nudge: Nudge | null;
}
export interface Nudge { reason: string; prs: { key: string; url: string; waitedMin: number }[]; message: string }

export const EMPTY_STATE: NudgeState = { approvedAt: 0, approvedHandled: 0, draftAt: 0, draftHandled: 0, lastNudgeAt: 0, emitSeq: 0, emptyHeldSince: 0, nudge: null };

/** Whether the nudge runs at all: switched on and with a nonzero delay (`repost_nudge_minutes: 0` is off). */
export const nudgeOn = (s: Pick<NudgeSettings, 'enabled' | 'minutes'>): boolean => s.enabled && s.minutes > 0;

/** True on one of `days` (0 is Sunday; default Monday to Friday) between `start` (inclusive) and `end` (exclusive) on the wall clock of `zone`. */
export function inWorkingHours(now: number, s: Pick<NudgeSettings, 'start' | 'end' | 'zone'> & { days?: readonly number[] }): boolean {
  const p = localParts(now, s.zone);
  return (s.days ?? DEFAULT_DAYS).includes(p.dow) && p.minutes >= clockMinutes(s.start) && p.minutes < clockMinutes(s.end);
}

/**
 * True when a PR's repo is one the nudge looks at: in `repost_nudge_repos` when that is set, else a repo other people review (not self-review) in an owner the
 * review queue counts. Approvals in any other repo do not start the clock and its PRs are never named.
 */
export function repoAllowed(repo: string, s: Pick<NudgeSettings, 'repos' | 'selfReview' | 'owners'>): boolean {
  if (s.repos.length) return isSelfReview(repo, s.repos);
  return !isSelfReview(repo, s.selfReview) && inQueueOwners(repo, s.owners);
}

/** The newest approval among the PRs the nudge looks at (epoch ms), 0 for none. */
export const approvalTime = (prs: readonly NudgePr[], s: Pick<NudgeSettings, 'repos' | 'selfReview' | 'owners'>): number =>
  Math.max(0, ...prs.filter((p) => repoAllowed(p.repo, s)).map((p) => p.approvedAt).filter(Number.isFinite));

/**
 * The PRs to repost: ready, waiting on reviewers (reviewDecision REVIEW_REQUIRED), not conflicting (GitHub's UNKNOWN, while it computes, passes), with no unresolved thread, in a repo `repoAllowed` accepts; oldest-waiting first, at most `count`. A PR changes-requested or approved is not waiting on a
 * reviewer, a conflicting one or one with open threads is not worth a reviewer's time yet.
 */
export function selectRepost(prs: readonly NudgePr[], now: number, s: Pick<NudgeSettings, 'count' | 'repos' | 'selfReview' | 'owners'>): Nudge['prs'] {
  return prs
    .filter((p) => !p.isDraft && p.reviewDecision === 'REVIEW_REQUIRED' && p.mergeable !== 'CONFLICTING' && p.unresolvedThreads === 0
      && repoAllowed(p.repo, s))
    .sort((a, b) => (Number.isFinite(a.readySince) ? a.readySince : now) - (Number.isFinite(b.readySince) ? b.readySince : now))
    .slice(0, s.count)
    .map((p) => ({ key: `${p.repo}#${p.number}`, url: p.url, waitedMin: Number.isFinite(p.readySince) ? Math.max(0, Math.floor((now - p.readySince) / 60_000)) : 0 }));
}

/** The one-line Slack message to paste: asks for reviews and lists the links. */
export const slackMessage = (prs: Nudge['prs']): string =>
  `Could I get a review on ${prs.length === 1 ? 'this PR' : 'these PRs'}? ${prs.map((p) => p.url).join(' ')}`;

/**
 * One check. `approvedAt` and `draftAt` are the newest trigger times the caller saw this tick (0 for none). With no earlier state the triggers
 * already there are adopted without a nudge, so switching the type on does not nudge about old news. A due trigger is answered, nudge or not:
 * with nobody to repost there is nothing to say and nothing is held, unless `holdEmpty` keeps it for up to a day.
 */
export function advance(prev: NudgeState | null, seen: { approvedAt: number; draftAt: number; askedAt?: number }, prs: readonly NudgePr[], now: number, s: NudgeSettings): NudgeState {
  const approvedAt = Math.max(prev?.approvedAt ?? 0, seen.approvedAt);
  const draftAt = Math.max(prev?.draftAt ?? 0, seen.draftAt);
  if (!prev) return { ...EMPTY_STATE, approvedAt, approvedHandled: approvedAt, draftAt, draftHandled: draftAt };
  const st: NudgeState = { ...prev, approvedAt, draftAt };
  // A trigger that is switched off, or the whole nudge being off, answers what it sees, so switching it back on does not replay old news.
  const approvalOn = nudgeOn(s) && s.triggers.includes('approval');
  const draftOn = nudgeOn(s) && s.triggers.includes('teammate-review');
  const quiet: NudgeState = { ...st, approvedHandled: approvalOn ? st.approvedHandled : approvedAt, draftHandled: draftOn ? st.draftHandled : draftAt };
  const approvalDue = approvalOn && approvedAt > st.approvedHandled && now >= approvedAt + s.minutes * 60_000;
  const draftDue = draftOn && draftAt > st.draftHandled;
  if (!approvalDue && !draftDue) return quiet;
  if (!inWorkingHours(now, s) || now - st.lastNudgeAt < s.gapMinutes * 60_000) return quiet;
  // The user has just asked for reviews themselves: a nudge would repeat it. Held, not dropped: it is sent once the window has passed.
  if (seen.askedAt && now - seen.askedAt < s.askedMinutes * 60_000) return quiet;
  const answered = { ...quiet, approvedHandled: approvedAt, draftHandled: draftAt, emptyHeldSince: 0 };
  const named = selectRepost(prs, now, s);
  const heldSince = st.emptyHeldSince || now;
  if (!named.length) return s.holdEmpty && now - heldSince <= HOLD_EMPTY_MAX_MS ? { ...quiet, emptyHeldSince: heldSince } : answered;
  // It was held empty for over a day: drop it even though PRs have turned up, it is old news.
  if (st.emptyHeldSince && now - st.emptyHeldSince > HOLD_EMPTY_MAX_MS) return answered;
  const reason = draftDue ? 'a teammate review is queued' : `${s.minutes} min since the last approval`;
  return { ...answered, lastNudgeAt: now, emitSeq: st.emitSeq + 1, nudge: { reason, prs: named, message: slackMessage(named) } };
}

/** The digest line for a nudge: why, which PRs and the paste-ready message. One line, so the digest and the Podium show it whole. */
export const nudgeLine = (n: Nudge): string =>
  `repost-nudge: ${n.reason}; repost ${n.prs.length} PR${n.prs.length === 1 ? '' : 's'} waiting longest (${n.prs.map((p) => `${p.key} ${p.waitedMin}m`).join(', ')}). Slack: "${n.message}"`;
