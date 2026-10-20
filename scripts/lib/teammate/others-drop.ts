/**
 * When a listed PR leaves the Others' PRs list for being quiet. The other drop reasons (merged, closed, approved, picked up by another reviewer) are the
 * classifier in settled.ts; this file adds the one it does not have: no push, comment, review or re-request for two working days (`others_prs_drop_days`).
 * Weekends do not count, in the configured time zone (lib/teammate/working-time.ts). The same rule drops a row from the tab's read of the cache.
 *
 * A PR waiting on its author, where your review is the latest thing on it and the author has not pushed since, is not dropped for being quiet: it is
 * waiting, not abandoned, and it comes back to the top on a push or a re-request. It still leaves when it is merged, closed or approved.
 */
import { workingMs } from './working-time.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The staleness thresholds in milliseconds; a null threshold disables that check. `drop` is working time. */
export interface DropGate { tz: string; open: number | null; active: number | null; drop: number | null }

/** The gate from the settings (hours for `open` and `active`, working days for `drop`); an undefined setting disables its check. */
export const dropGate = (tz: string, s: { openHours?: number; activeHours?: number; dropDays?: number }): DropGate => ({
  tz, open: s.openHours === undefined ? null : s.openHours * HOUR_MS, active: s.activeHours === undefined ? null : s.activeHours * HOUR_MS, drop: s.dropDays === undefined ? null : s.dropDays * DAY_MS,
});

/** A review you posted that the author has not pushed after (a commit at or before the review). An approval is not waiting on anything. */
export function awaitingAuthor(p: { yourReview?: { state: string; at: string }; headAt?: string }): boolean {
  const r = p.yourReview;
  if (!r || (r.state !== 'COMMENTED' && r.state !== 'CHANGES_REQUESTED') || !p.headAt) return false;
  return Date.parse(p.headAt) <= Date.parse(r.at);
}

/** The newest sign of life, in ms: any of the given times (a push, review, comment or re-request moves GitHub's `updatedAt`; a Slack ask or the day it was listed also count). NaN when none is a date. */
export const lastActivity = (...times: (string | number | undefined)[]): number =>
  Math.max(...times.map((t) => (typeof t === 'number' ? t : Date.parse(t ?? '')) || 0)) || Number.NaN;

/** Opened inside the open window: too new to be stale whatever its activity. */
export const isYoung = (createdAt: string, now: number, gate: DropGate): boolean => gate.open !== null && now - Date.parse(createdAt) < gate.open;

/**
 * True when the PR has had no activity for more than the drop window in working time (never shorter than the active window) and is past the open window.
 * A PR whose last activity is unknown is not dropped.
 */
export function droppedForQuiet(p: { createdAt: string; yourReview?: { state: string; at: string }; headAt?: string }, last: number, now: number, gate: DropGate): boolean {
  if (gate.drop === null || isYoung(p.createdAt, now, gate) || awaitingAuthor(p) || !Number.isFinite(last)) return false;
  return workingMs(last, now, gate.tz) > Math.max(gate.drop, gate.active ?? 0);
}
