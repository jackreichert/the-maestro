/**
 * The ready gate: whether a draft may be marked ready for review. The review queue cap is only worth anything where a PR actually joins the queue,
 * and a draft joins it when it is promoted (drafts are never counted), so `pr-ready.ts` asks this before it calls `gh pr ready`.
 * Pure: the caller hands in the reading, the configuration and the PR being promoted, so it reads no configuration and calls no network.
 */
import { inQueueOwners, queueCount, reviewQueue, type QueuePr, type QueueReading } from './review-queue.ts';
import { isSelfReview } from './self-review.ts';

/** What the gate is told: the PR's repo (`owner/name`), the queue as read, and the settings that decide whether the repo is gated at all. */
export interface GateInput {
  repo: string;
  /** The PR being promoted; only its head and base branch are used (to see whether it is a staging twin). Its current review state is ignored: a conflict or a change request today is gone tomorrow. */
  candidate: Pick<QueuePr, 'headRefName' | 'baseRefName'>;
  /** The reading, which carries the PR list it counted: the gate re-counts that same list with the candidate added, never a second read. */
  reading: QueueReading;
  cap: number;
  selfReview: readonly string[];
  owners: readonly string[];
  /** `--over-cap "<reason>"`: lets a refused promotion through, and is logged. */
  overCapReason?: string;
}

export type GateVerdict =
  | { allow: true; gated: boolean; overridden: boolean; message: string }
  | { allow: false; message: string };

/** True when the repo draws on a reviewer pool the cap protects: its owner is in `review_queue_orgs` (or none are set) and it is not a self-review repo. */
export const isGatedRepo = (repo: string, selfReview: readonly string[], owners: readonly string[]): boolean => inQueueOwners(repo, owners) && !isSelfReview(repo, selfReview);

/**
 * Allow or refuse promoting one draft. An ungated repo (personal, self-review, another owner) is always allowed. Otherwise the promotion is allowed
 * while the queue has room, or when the PR would not add to it (a staging twin of an open develop PR; its own conflict or review state does not count, since that clears). At or over
 * the cap it is refused with the reading and the way out. A queue that cannot be read is refused too, never treated as empty. `overCapReason` lets a
 * refused promotion through with the reason carried in the message, which the caller logs.
 */
export function readyGate(i: GateInput): GateVerdict {
  if (!isGatedRepo(i.repo, i.selfReview, i.owners)) return { allow: true, gated: false, overridden: false, message: `review queue cap does not apply to ${i.repo} (not a gated reviewer pool)` };
  const reason = i.overCapReason?.trim();
  if (!i.reading.ok) {
    const why = `${i.reading.error}. Treat the queue as full.`;
    return reason ? { allow: true, gated: true, overridden: true, message: `${why} Marking ready anyway: --over-cap "${reason}"` } : { allow: false, message: `${why} Retry when it can be read, or pass --over-cap "<reason>".` };
  }
  const q = i.reading.queue;
  const waiting: QueuePr = { headRefName: i.candidate.headRefName, baseRefName: i.candidate.baseRefName, repo: i.repo, isDraft: false };
  const adds = reviewQueue([...i.reading.prs, waiting], i.cap, i.selfReview, i.owners).count > q.count;
  if (!q.full || !adds) return { allow: true, gated: true, overridden: false, message: `review queue: ${queueCount(q)}${q.full ? '; this PR adds nothing to it' : ''}` };
  const state = `review queue: ${queueCount(q)}`;
  if (reason) return { allow: true, gated: true, overridden: true, message: `${state}. Marking ready over the cap: --over-cap "${reason}"` };
  return { allow: false, message: `${state}. Not marking ${i.repo} ready: the cap is the most that waits on reviewers. Drive an open PR to merge (or fix what is waiting on you) and retry, or pass --over-cap "<reason>" to override; the override is logged.` };
}
