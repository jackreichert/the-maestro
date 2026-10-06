/**
 * The review queue: open, non-draft PRs of yours waiting on a human. The cap is the most the orchestrator lets pile up
 * before it stops dispatching new PR-producing work (reference/dispatch.md#review-queue-cap).
 * Pure: callers hand in the PR list (a live fetch, the stored snapshot or the status page cache) and the cap.
 */
import { existsSync, readFileSync } from 'node:fs';
import { REVIEW_QUEUE_CAP } from '../local-config.ts';

/** The one field the count reads. Every PR source the scripts use carries it. */
export interface QueuePr { isDraft: boolean }

export interface ReviewQueue { count: number; cap: number; full: boolean }

/** Open non-draft PRs against the cap. The input is already scoped to open PRs by their author (PR_SEARCH). Full means count >= cap. */
export function reviewQueue(prs: readonly QueuePr[], cap: number = REVIEW_QUEUE_CAP): ReviewQueue {
  const count = prs.filter((p) => !p.isDraft).length;
  return { count, cap, full: count >= cap };
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

/**
 * The queue for the dispatch gate. A live read is preferred; a failed one falls back to the stored snapshot, and the reading says so,
 * so a stale count is never passed off as current. With neither, the answer is unknown (ok: false), never "empty".
 */
export function readQueue(src: QueueSources, cap: number = REVIEW_QUEUE_CAP): QueueReading {
  let liveError: string;
  try { return { ok: true, queue: reviewQueue(src.fetchLive().prs, cap), source: 'live' }; } catch (e) { liveError = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''; }
  const stored = src.readStored();
  if (!stored) return { ok: false, error: `cannot read the review queue: GitHub read failed (${liveError}) and there is no usable snapshot` };
  return { ok: true, queue: reviewQueue(stored.prs, cap), source: 'snapshot', takenAt: stored.takenAt, liveError };
}

/** Exit code for the gate: 0 room to dispatch, 1 full, 2 unknown. */
export const queueExitCode = (r: QueueReading): number => (!r.ok ? 2 : r.queue.full ? 1 : 0);

/** The one-line answer, plus the instruction when full or unknown. */
export function queueText(r: QueueReading): string[] {
  if (!r.ok) return [r.error, 'Treat the queue as full: dispatch only fixes to PRs already open until it can be read.'];
  const where = r.source === 'live' ? 'live' : `stored snapshot ${r.takenAt ?? 'of unknown age'}; live read failed: ${r.liveError}`;
  return [`${reviewQueueLine(r.queue)} (${where})`, ...(r.queue.full ? ['Queue full: dispatch no new PR-producing work except fixes to PRs already open.'] : [])];
}
