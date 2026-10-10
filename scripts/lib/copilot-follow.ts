/**
 * Copilot follow-up after a push: one small state machine per (PR, head sha), kept in pr-watch's snapshot.
 *
 * pr-watch's older rule asks Copilot for a review once per PR, ever. A push gives the PR a new head sha, and Copilot
 * only re-reviews it when the repo is set to review new pushes, so a later push can go unreviewed with nothing saying so.
 * This follows each head sha instead:
 *
 *   watching  -> the head was first seen. After GRACE_MS, if Copilot has neither a pending request nor a review for
 *                the sha, request it (once per sha, retried on a failed call up to MAX_ATTEMPTS) -> triggered.
 *   triggered -> Copilot is on it (it re-triggered itself, or we asked). A review on the sha raises COPILOT-REVIEW with
 *                the unresolved bot thread count; nothing by ESCALATE_MS after the trigger raises COPILOT-LATE.
 *   done      -> told. It stays until the head moves, which is what makes "once per head sha" hold across ticks.
 *
 * Time is the caller's tick: a delay is a minimum, and the loop's own cadence is its granularity. Every gh call goes
 * through the injected `run`, so tests use a fake. Pure otherwise: `advance` returns the next track and what to say.
 */
import type { Run } from './types.ts';

export const GRACE_MS = 60_000;
/** Measured Copilot review latency (41 reviews, 2026-10-08/09): median 2.3 min, p90 3.2, max 12.6. */
export const REPORT_AFTER_MS = 5 * 60_000;
export const ESCALATE_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 3;

export type Phase = 'watching' | 'triggered' | 'done';

/** What is remembered about one (PR, head sha). */
export interface Track {
  phase: Phase;
  /** Epoch ms the head was first seen. */
  seenAt: number;
  /** Epoch ms Copilot was found triggered, or asked. */
  triggerAt?: number;
  /** Failed request calls so far. */
  attempts: number;
  /** Told without a live look: a head that was already there when tracking began. */
  adopted?: boolean;
}

/** Every track keyed `owner/repo#n@sha`. */
export type Tracks = Record<string, Track>;

/** What the board says about one PR head. */
export interface Observation {
  /** Copilot has a pending review request. */
  pending: boolean;
  /** Copilot's latest review is on this head sha. */
  reviewed: boolean;
  /** Unresolved review threads whose first comment is from a bot. */
  botThreads: number;
}

export interface Outcome { track: Track; events: { summary: string; actionable: boolean }[] }

export const trackKey = (prKey: string, head: string): string => `${prKey}@${head}`;

/** A head met for the first time. `adopt` records it as told (the first check, or a snapshot from before this existed). */
export function begin(now: number, adopt: boolean): Track {
  return adopt ? { phase: 'done', seenAt: now, attempts: 0, adopted: true } : { phase: 'watching', seenAt: now, attempts: 0 };
}

const minutes = (ms: number): number => Math.floor(ms / 60_000);

/**
 * The next state for one head. `ask` makes the request and returns whether gh accepted it; it is called only here, only
 * from `watching`, so a sha is asked for once unless the call itself failed.
 */
export function advance(prKey: string, head: string, track: Track, obs: Observation, now: number, ask: () => boolean): Outcome {
  const id = `${prKey} ${head.slice(0, 7)}`;
  if (track.phase === 'done') return { track, events: [] };
  let t = track;
  if (t.phase === 'watching') {
    if (obs.pending || obs.reviewed) t = { ...t, phase: 'triggered', triggerAt: now };
    else if (now - t.seenAt >= GRACE_MS) {
      if (ask()) t = { ...t, phase: 'triggered', triggerAt: now };
      else {
        t = { ...t, attempts: t.attempts + 1 };
        if (t.attempts >= MAX_ATTEMPTS) return { track: { ...t, phase: 'done' }, events: [{ summary: `COPILOT-REQUEST-FAILED ${id}: ${MAX_ATTEMPTS} attempts to request a review failed`, actionable: true }] };
      }
    }
  }
  if (t.phase !== 'triggered') return { track: t, events: [] };
  const since = now - (t.triggerAt ?? now);
  if (obs.reviewed) {
    const n = obs.botThreads;
    return { track: { ...t, phase: 'done' }, events: [{ summary: `COPILOT-REVIEW ${id}: reviewed, ${n} unresolved bot thread${n === 1 ? '' : 's'}`, actionable: n > 0 }] };
  }
  if (since >= ESCALATE_MS) return { track: { ...t, phase: 'done' }, events: [{ summary: `COPILOT-LATE ${id}: no Copilot review ${minutes(since)} min after it was triggered`, actionable: true }] };
  return { track: t, events: [] };
}

/** Asks gh to add Copilot as a reviewer; true when gh accepted it. A repeat add is a no-op on GitHub's side. */
export function requestReview(run: Run, repo: string, number: number): boolean {
  return run('gh', ['pr', 'edit', String(number), '--repo', repo, '--add-reviewer', '@copilot']).status === 0;
}
