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
  /** The PR being promoted, as it will look once ready; its repo is filled in from `repo`. */
  candidate: Omit<QueuePr, 'isDraft' | 'repo'>;
  reading: QueueReading;
  /** The other open PRs the reading was made from; the gate re-counts them with the candidate added to see whether it raises the count. */
  prs: readonly QueuePr[];
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
 * while the queue has room, or when the PR would not add to it (a staging twin of an open develop PR, or a PR that waits on its author). At or over
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
  const adds = reviewQueue([...i.prs, { ...i.candidate, repo: i.repo, isDraft: false }], i.cap, i.selfReview, i.owners).count > q.count;
  if (!q.full || !adds) return { allow: true, gated: true, overridden: false, message: `review queue: ${queueCount(q)}${q.full ? '; this PR adds nothing to it' : ''}` };
  const state = `review queue: ${queueCount(q)}`;
  if (reason) return { allow: true, gated: true, overridden: true, message: `${state}. Marking ready over the cap: --over-cap "${reason}"` };
  return { allow: false, message: `${state}. Not marking ${i.repo} ready: the cap is the most that waits on reviewers. Drive an open PR to merge (or fix what is waiting on you) and retry, or pass --over-cap "<reason>" to override; the override is logged.` };
}
