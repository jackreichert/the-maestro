/**
 * suite-done: wakes the orchestrator when a detached suite job (scripts/suite-run.ts) finishes, with no model waiting on it. Target is the job id
 * `suite-run.ts start` printed. The job is done when its results.json exists; a worker that died without writing one counts as done too (`lost`),
 * so a crash is reported instead of waited on forever. Either is one actionable event, then the watch retires.
 * State { state, summary }: `state` is running, done or lost, and `summary` is the one-line result (suite-run.ts statusLine) once it is not running.
 * `add` refuses an id that is not a job id, or a job that does not exist, so a typo fails at once instead of expiring unseen.
 * The event is unowned (no repo): the orchestrator starts a fresh reviewer with the diff and results.json.
 */
import { SUITE_WATCH_TTL_MS, jobStatus, statusLine, suitesDir } from '../suite-run.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface SuiteDoneState { state: 'running' | 'done' | 'lost'; summary: string }

// Scheduling: a local file read every 30 s (the local floor). A suite finishes in minutes, so no idle back-off. It runs through quiet hours (a job started at
// 22:30 ends overnight and must be reported, not expire unseen), and its TTL outlasts any quiet window.
export const interval = 30;
export const network = false;
export const backoff = false;
export const quietExempt = true;
export const defaultTtlMs = (): number => SUITE_WATCH_TTL_MS;

export function validate(target: string): void {
  if (jobStatus(target).state === 'unknown') throw new Error(`suite-done target must be an existing job id from suite-run.ts start, got "${target}" (looked in ${suitesDir()})`);
}

export function check(target: string, _ctx?: Pick<CheckContext, 'now'>, base: string = suitesDir()): SuiteDoneState {
  const s = jobStatus(target, base);
  if (s.state === 'running') return { state: 'running', summary: '' };
  // A job whose directory vanished is gone for good: report it as lost rather than watching nothing.
  return { state: s.state === 'done' ? 'done' : 'lost', summary: statusLine(s) };
}

export function diff(_prev: SuiteDoneState | null, next: SuiteDoneState): WatchEvent[] {
  if (next.state === 'running') return [];
  return [{ summary: `${next.summary}; start a fresh reviewer with the diff and results.json`, actionable: true }];
}

export const done = (state: SuiteDoneState): boolean => state.state !== 'running';
