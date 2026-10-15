/**
 * The review queue: open, non-draft PRs of yours waiting on a human reviewer. The cap is the most the orchestrator lets pile up
 * before a finished branch is held as ready to push, not pushed; the work itself carries on locally (reference/dispatch.md#review-queue-cap).
 * Pure: callers hand in the PR list (a live fetch, the stored snapshot or the status page cache) and the cap (`REVIEW_QUEUE_CAP`, local-config.ts).
 * It reads no configuration, so the page renderer can import it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { splitSelfReview } from './self-review.ts';

/**
 * The fields the count reads. Every PR source the scripts use carries `isDraft`; `repo` (`owner/name`) is what `self_review_repos` is matched against.
 * `reviewDecision`, `mergeable` and the two branch names come from the snapshot and the live read; a source or an older snapshot that omits them
 * is read as "no decision, mergeable, not a twin", so the PR counts as waiting on reviewers (fail closed toward counting).
 */
export interface QueuePr { isDraft: boolean; repo?: string; reviewDecision?: string | null; mergeable?: string | null; baseRefName?: string; headRefName?: string }

/**
 * `count` is the PRs waiting on reviewers: the number the cap applies to. `waitingOnYou` is the author's own backlog (changes requested, a merge
 * conflict, approved but unmerged), which no reviewer can move and the cap does not count. `twins` is how many staging twins were folded into their
 * develop twin. `selfReview` is how many non-draft PRs sit in a self-review repo: only their owner reviews them, so they are in neither number.
 */
export interface ReviewQueue { count: number; cap: number; full: boolean; selfReview: number; waitingOnYou: number; twins: number }

/** The branch a staging twin targets; its develop twin is the same head branch aimed at any other base (the same rule `prs-snapshot.ts` uses for twin flow). */
const TWIN_BASE = 'staging';

/**
 * True when the author, not a reviewer, holds the ball: changes were requested, the PR conflicts, or it is approved and only waiting to be merged.
 * Anything else (no decision, review required, unknown) is waiting on reviewers.
 */
export const waitingOnAuthor = (p: QueuePr): boolean => p.reviewDecision === 'CHANGES_REQUESTED' || p.reviewDecision === 'APPROVED' || p.mergeable === 'CONFLICTING';

/** The key two PRs share when they are the same change aimed at two bases: repo and head branch, case-insensitive. */
const twinKey = (p: QueuePr): string => `${(p.repo ?? '').toLowerCase()}|${p.headRefName ?? ''}`;

/** Drops each staging twin that has an open develop twin (same repo and head branch, another base), so one change is one place in the queue. A stacked child is not a twin and stays. */
function foldTwins<T extends QueuePr>(prs: readonly T[]): { kept: T[]; twins: number } {
  const dev = new Set(prs.filter((p) => p.headRefName && p.baseRefName && p.baseRefName !== TWIN_BASE).map(twinKey));
  const kept = prs.filter((p) => !(p.headRefName && p.baseRefName === TWIN_BASE && dev.has(twinKey(p))));
  return { kept, twins: prs.length - kept.length };
}

/**
 * True when the PR's repo owner is in `owners` (`review_queue_orgs`, case-insensitive). No owners configured means no filter, and a PR with no repo
 * is kept: the count fails closed toward counting, as it does for self-review, so a source that omits `repo` is never silently dropped.
 */
export const inQueueOwners = (repo: string | undefined, owners: readonly string[]): boolean =>
  !owners.length || !repo || owners.some((o) => o.toLowerCase() === repo.split('/')[0]!.toLowerCase());

/**
 * Open non-draft PRs against the cap. The input is already scoped to open PRs by their author (PR_SEARCH). Full means count >= cap, and `count` is
 * only the PRs waiting on reviewers: the cap models other reviewers' attention, so the author's own backlog (`waitingOnAuthor`) is reported beside it, not in it.
 * A staging twin whose develop twin is open counts once, as its develop twin; a PR stacked on the author's own branch counts, because reviewers still read it.
 * Only PRs whose repo owner is in `owners` (review_queue_orgs) count: a stale snapshot or another source cannot leak a personal repo's PR into the cap.
 * PRs in a `selfReview` repo (self_review_repos) are left out too: these have no other reviewer. A PR with no repo is counted.
 */
export function reviewQueue(prs: readonly QueuePr[], cap: number, selfReview: readonly string[] = [], owners: readonly string[] = []): ReviewQueue {
  const open = prs.filter((p) => !p.isDraft && inQueueOwners(p.repo, owners));
  const { org, self } = splitSelfReview(open, selfReview);
  const { kept, twins } = foldTwins(org);
  const waitingOnYou = kept.filter(waitingOnAuthor).length;
  const count = kept.length - waitingOnYou;
  return { count, cap, full: count >= cap, selfReview: self.length, waitingOnYou, twins };
}

/** The board line: `review queue: 3 of 4 waiting on reviewers`, with `(full)` once the cap is reached (see `queueCount`). */
export const reviewQueueLine = (q: ReviewQueue): string => `review queue: ${queueCount(q)}`;

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
export function readQueue(src: QueueSources, cap: number, now: Date = new Date(), selfReview: readonly string[] = [], owners: readonly string[] = []): QueueReading {
  let liveError: string;
  try { return { ok: true, queue: reviewQueue(src.fetchLive().prs, cap, selfReview, owners), source: 'live' }; } catch (e) { liveError = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''; }
  const stored = src.readStored();
  if (!stored) return { ok: false, error: `cannot read the review queue: GitHub read failed (${liveError}) and there is no usable snapshot` };
  const ageMs = stored.takenAt ? now.getTime() - Date.parse(stored.takenAt) : Number.NaN;
  if (!(ageMs <= MAX_FALLBACK_AGE_MS)) return { ok: false, error: `cannot read the review queue: GitHub read failed (${liveError}) and the stored snapshot is ${stored.takenAt ? `from ${stored.takenAt}, over ${MAX_FALLBACK_AGE_MS / 36e5} hours old` : 'of unknown age'}` };
  return { ok: true, queue: reviewQueue(stored.prs, cap, selfReview, owners), source: 'snapshot', takenAt: stored.takenAt, liveError };
}

/** Exit code for the gate: 0 room to dispatch, 1 full, 2 unknown. */
export const queueExitCode = (r: QueueReading): number => (!r.ok ? 2 : r.queue.full ? 1 : 0);

/** The one-line answer, plus the instruction when full or unknown. */
export function queueText(r: QueueReading): string[] {
  if (!r.ok) return [r.error, 'Treat the queue as full: hold pushes of new PRs (keep working locally) until it can be read.'];
  const where = r.source === 'live' ? 'live' : `stored snapshot ${r.takenAt ?? 'of unknown age'}; live read failed: ${r.liveError}`;
  return [`${reviewQueueLine(r.queue)} (${where})`, ...(r.queue.full ? ['Queue full: hold pushes of new PRs and do not mark drafts ready (keep working locally); fixes to PRs already open still go out. pr-ready.ts enforces this; --over-cap "<reason>" overrides it, logged.'] : [])];
}

/** How old a snapshot must be before the board names its age: the loop refreshes the stored PR board on its idle tick, so a few minutes is normal and ten is a sign the refresh is not running. */
export const STALE_SNAPSHOT_MS = 10 * 60_000;

/** ` (snapshot 40m old)`, `5h`, `3d`: how old a snapshot is, for the board line; empty when it is under ten minutes old or its time is unknown (the board reads it without a network call, so a PR merged since then still shows as open until the next refresh). */
export function staleSuffix(takenAt: string | undefined, now: Date): string {
  const ms = takenAt ? now.getTime() - Date.parse(takenAt) : Number.NaN;
  if (!Number.isFinite(ms) || ms < STALE_SNAPSHOT_MS) return '';
  if (ms < 36e5) return ` (snapshot ${Math.floor(ms / 60_000)}m old)`;
  const hours = Math.floor(ms / 36e5);
  return ` (snapshot ${hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`} old)`;
}

/**
 * `3 of 4 waiting on reviewers`, `4 of 4 waiting on reviewers (full)`, `11 of 4 waiting on reviewers (7 over) · 4 waiting on you`: the one wording for the
 * count, shared by the push gate, the board, the snapshot footer and the live footer. The `waiting on you` part is left out when it is zero.
 */
export const queueCount = (q: ReviewQueue): string =>
  `${q.count} of ${q.cap} waiting on reviewers${q.count > q.cap ? ` (${q.count - q.cap} over)` : q.full ? ' (full)' : ''}${q.waitingOnYou ? ` · ${q.waitingOnYou} waiting on you` : ''}`;

/**
 * The board's review queue from the stored snapshot, no network: `review queue: 3 of 4` (plus `(full)` and a stale-snapshot note), or
 * null when there is no usable snapshot. The footer uses the same text with `**Review queue:**` as its label.
 */
export function boardQueue(stored: { prs: readonly QueuePr[]; takenAt?: string } | null, cap: number, now: Date, selfReview: readonly string[] = [], owners: readonly string[] = []): { text: string; footer: string } | null {
  if (!stored) return null;
  const q = reviewQueue(stored.prs, cap, selfReview, owners);
  const tail = `${queueCount(q)}${staleSuffix(stored.takenAt, now)}`;
  return { text: `review queue: ${tail}`, footer: `**Review queue:** ${tail}` };
}

/** A stored snapshot older than this is not shown on the footer: the footer reads the live queue instead (the loop's idle tick keeps the snapshot a few minutes old at most). */
export const FOOTER_REFRESH_MS = 30 * 60_000;

/**
 * The footer's `**Review queue:**` line. A snapshot under 30 minutes old is shown as `boardQueue` shows it (no network). An older or
 * undated one is refreshed through `refresh` (a live read) and the live count printed; if that read fails the line says `unknown` and
 * names the snapshot's age, never the old number. With no snapshot at all the line is absent (null). A count above the cap says by how much.
 */
export function footerQueue(stored: { prs: readonly QueuePr[]; takenAt?: string } | null, cap: number, now: Date, selfReview: readonly string[], refresh: () => { prs: readonly QueuePr[] }, owners: readonly string[] = []): string | null {
  if (!stored) return null;
  const ageMs = stored.takenAt ? now.getTime() - Date.parse(stored.takenAt) : Number.NaN;
  if (ageMs < FOOTER_REFRESH_MS) return boardQueue(stored, cap, now, selfReview, owners)?.footer ?? null;
  try {
    const q = reviewQueue(refresh().prs, cap, selfReview, owners);
    return `**Review queue:** ${queueCount(q)}`;
  } catch {
    const age = staleSuffix(stored.takenAt, now).replace(/^ \(snapshot (.*) old\)$/, '$1');
    return `**Review queue:** unknown (snapshot ${age ? `${age} old` : 'of unknown age'}; live refresh failed)`;
  }
}
