/**
 * pr-checks: CI status of one PR. Target `owner/repo#123` (or the PR URL).
 * State { overall: none|pending|passing|failing, total, failed[], settled }. Done_when: `settled` (default,
 * no check still pending) or `passing`. Actionable: a move into failing or passing. A re-run (back to pending) is informational.
 */
import type { CheckContext, WatchEvent } from '../lib/types.ts';

/** gh's `bucket` for one check: pass, fail, pending, skipping or cancel. */
export interface CheckRun { name: string; bucket: string }

export interface PrChecksState { overall: 'none' | 'pending' | 'passing' | 'failing'; total: number; failed: string[]; settled: boolean }

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = 180;
export const network = true;
const TARGET = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/;
const MAX_NAMED = 5;
// gh pr checks exits 8 while checks are pending and 1 when any failed; both still print the JSON.
// Exit 1 with an empty body is also how gh says "no checks reported"; any other empty exit 1 (auth, not found) is an error.
const OK_STATUS = new Set([0, 1, 8]);
const NO_CHECKS = /no checks reported/i;

export const parseTarget = (target: unknown): { repo: string; number: string } => {
  const m = String(target).match(TARGET);
  if (!m) throw new Error(`pr-checks target must look like owner/repo#123, got "${target}"`);
  return { repo: m[1] as string, number: m[2] as string };
};

/** Folds gh's `bucket` per check (pass, fail, pending, skipping, cancel) into one state. */
export function summarize(checks: CheckRun[]): PrChecksState {
  const by = (...buckets: string[]) => checks.filter((c) => buckets.includes(c.bucket));
  const failed = by('fail', 'cancel').map((c) => c.name).sort();
  const pending = by('pending').length;
  const overall = failed.length ? 'failing' : pending ? 'pending' : checks.length ? 'passing' : 'none';
  return { overall, total: checks.length, failed, settled: checks.length > 0 && pending === 0 };
}

export function check(target: string, ctx: Pick<CheckContext, 'run'>): PrChecksState {
  const { repo, number } = parseTarget(target);
  const r = ctx.run('gh', ['pr', 'checks', number, '--repo', repo, '--json', 'name,bucket']);
  const empty = !r.stdout.trim();
  if (r.status === null || !OK_STATUS.has(r.status) || (empty && !(r.status === 1 && NO_CHECKS.test(r.stderr || '')))) {
    throw new Error(`gh pr checks failed: ${(r.stderr || '').split('\n')[0]}`);
  }
  if (empty) return summarize([]);
  return summarize(JSON.parse(r.stdout) as CheckRun[]);
}

export function diff(prev: PrChecksState | null, next: PrChecksState): WatchEvent[] {
  const names = next.failed.length > MAX_NAMED ? `${next.failed.slice(0, MAX_NAMED).join(', ')} and ${next.failed.length - MAX_NAMED} more` : next.failed.join(', ');
  const now: WatchEvent | null = next.overall === 'failing' ? { summary: `CI failing: ${names}` }
    : next.overall === 'passing' ? { summary: `CI passing (${next.total} checks)` } : null;
  if (!prev) return now ? [now] : [];
  const changed = prev.overall !== next.overall || prev.failed.join() !== next.failed.join();
  if (!changed) return [];
  return now ? [now] : [{ summary: `CI is ${next.overall}`, actionable: false }];
}

export const done = (state: PrChecksState, watch: { done_when?: string }): boolean => (watch.done_when === 'passing' ? state.overall === 'passing' : state.settled);
