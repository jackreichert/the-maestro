/**
 * roll-maintenance: runs the loop-safe half of roll on the first check of each new local day, with no model involved. Target is the
 * container directory (the folder holding the repos). One run is `journal.ts maintain --today <day> --container <target>`: archive
 * the past days that still owe one, then sweep the clean worktrees (never --force, never a remote branch; a dirty one is listed, not touched),
 * recording the `branch-sweep` standing row through the same guard roll uses. Triage, the epic and notes reports and the env asks stay in roll.
 *
 * A check is due when no run has finished cleanly on the current local day (WATCH_TZ), so a new day, a first check and a failed run
 * all count; a check is otherwise free. A clean run is silent. A failed one (any problem `maintain` reports, a result it never printed,
 * a crash or a timeout) is retried after an hour and raised as one actionable event per new message; the event is the alert.
 * maintain is idempotent and takes its own lock, so a retry, a manual roll or a second machine cannot double-archive.
 * State { ranDay, retryAt, error, last } is the whole memory (last: counts of the newest clean run, for the playbook, never an event).
 * Scheduling: a 15 minute check, singleton, renews, no idle back-off; it never notifies unless the watch is added with --notify.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMaintainLine } from '../lib/journal/maintain.ts';
import { localDate } from '../lib/status-page/priorities.ts';
import { WATCH_TZ } from '../local-config.ts';
import type { MaintainResult } from '../lib/journal/maintain.ts';
import type { CheckContext, Run, WatchEvent } from '../lib/types.ts';

export interface RollMaintenanceState { ranDay: string; retryAt: number; error: string; last: string }

export const interval = 900;
export const renews = true;
export const network = true;
export const backoff = false;
export const singleton = true;

export const RETRY_MS = 60 * 60_000;
/** Seconds the sweep may spend; the loop's own command timeout is 120, so this leaves room to finish and print. */
export const SWEEP_BUDGET_SECONDS = 90;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`roll-maintenance target must be the container directory (the folder holding your repos), got "${target}"`);
}

/** The outside world: the local day, and one `maintain` run. Tests replace it. */
export interface MaintenanceIo {
  localDay(now: number): string;
  /** Runs maintain and returns its result; throws when it could not (crash, timeout, no result line). */
  maintain(target: string, today: string, run: Run): MaintainResult;
}

const JOURNAL = fileURLToPath(new URL('../journal.ts', import.meta.url));

export const realIo: MaintenanceIo = {
  localDay: (now) => localDate(new Date(now), WATCH_TZ),
  maintain: (target, today, run) => {
    const r = run(process.execPath, [JOURNAL, 'maintain', '--today', today, '--container', target, '--budget', String(SWEEP_BUDGET_SECONDS)]);
    const result = parseMaintainLine(r.stdout);
    if (result) return result;
    const why = (r.stderr || r.stdout).trim().split('\n').pop() ?? '';
    throw new Error(`maintain printed no result (exit ${r.status}${why ? `: ${why.slice(0, 160)}` : ''})`);
  },
};

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] || 'unknown error';
const describe = (r: MaintainResult): string => `archived ${r.archivedDays.length} day(s), swept ${r.sweep ? `${r.sweep.removed} removed, ${r.sweep.pruned} pruned, ${r.sweep.kept} kept` : 'nothing'}`;

export function check(target: string, ctx: Pick<CheckContext, 'now' | 'prev' | 'run'>, io: MaintenanceIo = realIo): RollMaintenanceState {
  const prev = (ctx.prev as RollMaintenanceState | null | undefined) ?? { ranDay: '', retryAt: 0, error: '', last: '' };
  const today = io.localDay(ctx.now);
  if (prev.ranDay === today || ctx.now < prev.retryAt) return prev;
  try {
    const r = io.maintain(target, today, ctx.run as Run);
    if (r.ok) return { ranDay: today, retryAt: 0, error: '', last: describe(r) };
    return { ...prev, retryAt: ctx.now + RETRY_MS, error: r.problems.join('; ').slice(0, 300) || 'maintain reported a failure' };
  } catch (e) {
    // A throw would only count towards the loop's "check keeps failing" notice; the retry and the alert are this type's own.
    return { ...prev, retryAt: ctx.now + RETRY_MS, error: firstLine(e).slice(0, 300) };
  }
}

/** Silent unless a run newly fails (a different message than last time); that one event is the alert. */
export const diff = (prev: RollMaintenanceState | null, next: RollMaintenanceState): WatchEvent[] =>
  next.error && next.error !== prev?.error ? [{ summary: `roll maintenance failed: ${next.error}`, actionable: true }] : [];
