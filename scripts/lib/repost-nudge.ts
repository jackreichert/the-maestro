/**
 * The repost nudge, pure: when the user should be nudged to repost their PRs in Slack, and which PRs to name.
 * Two triggers feed it: an approval on one of the user's open PRs (the nudge is due `minutes` later) and a teammate review draft
 * queued or posted (due at once). A due nudge goes out only in working hours (weekdays between start and end, in a zone), at most one
 * an hour; a nudge due outside them is held, and one is sent when the hours open. Reads no clock, no config and no network:
 * event-types/repost-nudge.ts hands it the PRs, the trigger times and the settings.
 */
import { isSelfReview } from './self-review.ts';
import { inQueueOwners } from './review-queue.ts';
import { localParts } from './recurring-time.ts';

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
  minutes: number; askedMinutes: number; count: number; start: string; end: string; zone: string;
  selfReview: readonly string[]; owners: readonly string[];
}

/** What the loop remembers between checks. Times are epoch ms; 0 means never. */
export interface NudgeState {
  /** Latest approval and latest teammate-draft time seen, and how much of each a nudge has already answered. */
  approvedAt: number; approvedHandled: number; draftAt: number; draftHandled: number;
  lastNudgeAt: number; emitSeq: number;
  /** The nudge raised by the latest emit; empty before the first. */
  nudge: Nudge | null;
}
export interface Nudge { reason: string; prs: { key: string; url: string; waitedMin: number }[]; message: string }

export const EMPTY_STATE: NudgeState = { approvedAt: 0, approvedHandled: 0, draftAt: 0, draftHandled: 0, lastNudgeAt: 0, emitSeq: 0, nudge: null };

const clockMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True on a weekday between `start` (inclusive) and `end` (exclusive) on the wall clock of `zone`. */
export function inWorkingHours(now: number, s: Pick<NudgeSettings, 'start' | 'end' | 'zone'>): boolean {
  const p = localParts(now, s.zone);
  return p.dow >= 1 && p.dow <= 5 && p.minutes >= clockMinutes(s.start) && p.minutes < clockMinutes(s.end);
}

/**
 * The PRs to repost: ready, waiting on reviewers (reviewDecision REVIEW_REQUIRED), not conflicting (GitHub's UNKNOWN, while it computes, passes), with no unresolved thread, in a repo other people
 * review and an owner the review queue counts; oldest-waiting first, at most `count`. A PR changes-requested or approved is not waiting on a
 * reviewer, a conflicting one or one with open threads is not worth a reviewer's time yet.
 */
export function selectRepost(prs: readonly NudgePr[], now: number, s: Pick<NudgeSettings, 'count' | 'selfReview' | 'owners'>): Nudge['prs'] {
  return prs
    .filter((p) => !p.isDraft && p.reviewDecision === 'REVIEW_REQUIRED' && p.mergeable !== 'CONFLICTING' && p.unresolvedThreads === 0
      && !isSelfReview(p.repo, s.selfReview) && inQueueOwners(p.repo, s.owners))
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
 * with nobody to repost there is nothing to say and nothing is held.
 */
export function advance(prev: NudgeState | null, seen: { approvedAt: number; draftAt: number; askedAt?: number }, prs: readonly NudgePr[], now: number, s: NudgeSettings): NudgeState {
  const approvedAt = Math.max(prev?.approvedAt ?? 0, seen.approvedAt);
  const draftAt = Math.max(prev?.draftAt ?? 0, seen.draftAt);
  if (!prev) return { ...EMPTY_STATE, approvedAt, approvedHandled: approvedAt, draftAt, draftHandled: draftAt };
  const st: NudgeState = { ...prev, approvedAt, draftAt };
  if (!(s.minutes > 0)) return { ...st, approvedHandled: approvedAt, draftHandled: draftAt };
  const approvalDue = approvedAt > st.approvedHandled && now >= approvedAt + s.minutes * 60_000;
  const draftDue = draftAt > st.draftHandled;
  if (!approvalDue && !draftDue) return st;
  if (!inWorkingHours(now, s) || now - st.lastNudgeAt < HOUR_MS) return st;
  // The user has just asked for reviews themselves: a nudge would repeat it. Held, not dropped: it is sent once the window has passed.
  if (seen.askedAt && now - seen.askedAt < s.askedMinutes * 60_000) return st;
  const answered = { ...st, approvedHandled: approvedAt, draftHandled: draftAt };
  const named = selectRepost(prs, now, s);
  if (!named.length) return answered;
  const reason = draftDue ? 'a teammate review is queued' : `${s.minutes} min since the last approval`;
  return { ...answered, lastNudgeAt: now, emitSeq: st.emitSeq + 1, nudge: { reason, prs: named, message: slackMessage(named) } };
}

/** The digest line for a nudge: why, which PRs and the paste-ready message. One line, so the digest and the Podium show it whole. */
export const nudgeLine = (n: Nudge): string =>
  `repost-nudge: ${n.reason}; repost ${n.prs.length} PR${n.prs.length === 1 ? '' : 's'} waiting longest (${n.prs.map((p) => `${p.key} ${p.waitedMin}m`).join(', ')}). Slack: "${n.message}"`;
