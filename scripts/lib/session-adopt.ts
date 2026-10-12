/**
 * session-adopt.ts: what every SessionStart prints about adoption: the adopted queue line, the live wake schedule, and, only when the loop
 * is not running, the cron calls that mirror the wakes. Pure over its inputs; never throws, so it can never block a session start.
 * SEAM: slice 3 (the waiter registry) adds its "no live waiter, start digest-wait" line to this block; see `waiterLines`.
 */
import { adoptLine } from './adopt.ts';
import type { Adopt } from './adopt.ts';
import { cronMirrorLines, wakeScheduleLines } from './wake-schedule.ts';
import type { LoopState } from './loop-health.ts';
import type { Watch } from './types.ts';

export interface AdoptionInput { adopt: Adopt | null; watches: Watch[]; loop: LoopState; now: number }

const LOOP_UP: LoopState[] = ['ok', 'quiet', 'running'];

/** Lines the waiter registry will add (none until it lands). Kept as a named function so that slice has one place to hook in. */
export const waiterLines = (): string[] => [];

/** The adoption block, or '' when there is nothing to say. */
export function adoptionBlock({ adopt, watches, loop, now }: AdoptionInput): string {
  try {
    const schedule = wakeScheduleLines(watches, now);
    const mirror = LOOP_UP.includes(loop) ? [] : cronMirrorLines(watches, now);
    return [adoptLine(adopt), ...schedule, ...mirror, ...waiterLines()].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}
