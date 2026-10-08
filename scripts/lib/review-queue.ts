/**
 * The review queue: open, non-draft PRs of yours waiting on a human. The cap is the most the orchestrator lets pile up
 * before a finished branch is held as ready to push, not pushed; the work itself carries on locally (reference/dispatch.md#review-queue-cap).
 * Pure: callers hand in the PR list (a live fetch, the stored snapshot or the status page cache) and the cap (`REVIEW_QUEUE_CAP`, local-config.ts).
 * It reads no configuration, so the page renderer can import it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { splitSelfReview } from './self-review.ts';

/** The fields the count reads. Every PR source the scripts use carries `isDraft`; `repo` (`owner/name`) is what `self_review_repos` is matched against. */
export interface QueuePr { isDraft: boolean; repo?: string }

/** `selfReview` is how many non-draft PRs sit in a self-review repo: only their owner reviews them, so they are not in `count`. */
export interface ReviewQueue { count: number; cap: number; full: boolean; selfReview: number }

/**
 * Open non-draft PRs against the cap. The input is already scoped to open PRs by their author (PR_SEARCH). Full means count >= cap.
 * PRs in a `selfReview` repo (self_review_repos) are left out: the cap models other reviewers' attention, and these have none. A PR with no repo is counted.
 */
export function reviewQueue(prs: readonly QueuePr[], cap: number, selfReview: readonly string[] = []): ReviewQueue {
  const open = prs.filter((p) => !p.isDraft);
  const { org, self } = splitSelfReview(open, selfReview);
  return { count: org.length, cap, full: org.length >= cap, selfReview: self.length };
}

/** The board line: `review queue: 3 of 4`, with `(full)` once the cap is reached. */
export const reviewQueueLine = (q: ReviewQueue): string => `review queue: ${q.count} of ${q.cap}${q.full ? ' (full)' : ''}`;

/** The stored snapshot's PRs and when it was taken; null when the file is absent or not shaped like a snapshot. */
export function readSnapshotPrs(path: string): { prs: QueuePr[]; takenAt?: string } | null {
  if (!existsSync(path)) return null;
  try {
    const s: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const prs = (s as { prs?: unknown } | null)?.prs;
    if (!Array.isArray(prs) || !prs.every((p) => typeof (p as { isDraft?: unknown } | null)?.isDraft === 'boolean')) return null;
    const takenAt = (s as { takenAt?: unknown }).takenAt;
    return { prs: prs as QueuePr[], takenAt: typeof takenAt === 'string' ? takenAt : undefined };
  } catch { return null; }
}

/** What `journal.ts review-queue` reads: GitHub now, or the stored snapshot when GitHub cannot be read. Both are injected so tests use neither. */
export interface QueueSources {
  fetchLive(): { prs: readonly QueuePr[] };
  readStored(): { prs: readonly QueuePr[]; takenAt?: string } | null;
}

export type QueueReading =
  | { ok: true; queue: ReviewQueue; source: 'live' | 'snapshot'; takenAt?: string; liveError?: string }
  | { ok: false; error: string };

/** A fallback snapshot older than this is no answer: a stale count must not let new PR work through. */
const MAX_FALLBACK_AGE_MS = 6 * 36e5;

/**
 * The queue for the push gate. A live read is preferred; a failed one falls back to the stored snapshot, and the reading says so,
 * and one older than six hours (or undated) is refused, so a stale count is never passed off as current. With neither, the answer is unknown (ok: false), never "empty".
 */
export function readQueue(src: QueueSources, cap: number, now: Date = new Date(), selfReview: readonly string[] = []): QueueReading {
  let liveError: string;
  try { return { ok: true, queue: reviewQueue(src.fetchLive().prs, cap, selfReview), source: 'live' }; } catch (e) { liveError = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''; }
  const stored = src.readStored();
  if (!stored) return { ok: false, error: `cannot read the review queue: GitHub read failed (${liveError}) and there is no usable snapshot` };
  const ageMs = stored.takenAt ? now.getTime() - Date.parse(stored.takenAt) : Number.NaN;
  if (!(ageMs <= MAX_FALLBACK_AGE_MS)) return { ok: false, error: `cannot read the review queue: GitHub read failed (${liveError}) and the stored snapshot is ${stored.takenAt ? `from ${stored.takenAt}, over ${MAX_FALLBACK_AGE_MS / 36e5} hours old` : 'of unknown age'}` };
  return { ok: true, queue: reviewQueue(stored.prs, cap, selfReview), source: 'snapshot', takenAt: stored.takenAt, liveError };
}

/** Exit code for the gate: 0 room to dispatch, 1 full, 2 unknown. */
export const queueExitCode = (r: QueueReading): number => (!r.ok ? 2 : r.queue.full ? 1 : 0);

/** The one-line answer, plus the instruction when full or unknown. */
export function queueText(r: QueueReading): string[] {
  if (!r.ok) return [r.error, 'Treat the queue as full: hold pushes of new PRs (keep working locally) until it can be read.'];
  const where = r.source === 'live' ? 'live' : `stored snapshot ${r.takenAt ?? 'of unknown age'}; live read failed: ${r.liveError}`;
  return [`${reviewQueueLine(r.queue)} (${where})`, ...(r.queue.full ? ['Queue full: hold pushes of new PRs (keep working locally); fixes to PRs already open still go out.'] : [])];
}

/** `5h`, `3d`: how old a snapshot is, for the board line; empty when it is under an hour old or its time is unknown (the board reads it without a network call, so only a stale one is flagged). */
export function staleSuffix(takenAt: string | undefined, now: Date): string {
  const ms = takenAt ? now.getTime() - Date.parse(takenAt) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 36e5) return '';
  const hours = Math.floor(ms / 36e5);
  return ` (snapshot ${hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`} old)`;
}

/**
 * The board's review queue from the stored snapshot, no network: `review queue: 3 of 4` (plus `(full)` and a stale-snapshot note), or
 * null when there is no usable snapshot. The footer uses the same text with `**Review queue:**` as its label.
 */
export function boardQueue(stored: { prs: readonly QueuePr[]; takenAt?: string } | null, cap: number, now: Date, selfReview: readonly string[] = []): { text: string; footer: string } | null {
  if (!stored) return null;
  const q = reviewQueue(stored.prs, cap, selfReview);
  const tail = `${q.count} of ${q.cap}${q.full ? ' (full)' : ''}${staleSuffix(stored.takenAt, now)}`;
  return { text: `review queue: ${tail}`, footer: `**Review queue:** ${tail}` };
}
