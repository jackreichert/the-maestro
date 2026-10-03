/**
 * gh-run: one GitHub Actions run, until it completes. Target `owner/repo:<run id>`.
 * State { status, conclusion, name }. Actionable only on completion (any conclusion); a start is informational.
 */
import type { CheckContext, WatchEvent } from '../lib/types.ts';

/** What `check` keeps between ticks. */
export interface GhRunState { status: string; conclusion: string; name: string }

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = 120;
export const network = true;
const TARGET = /^([\w.-]+\/[\w.-]+):(\d+)$/;

export function check(target: string, ctx: Pick<CheckContext, 'run'>): GhRunState {
  const m = String(target).match(TARGET);
  if (!m) throw new Error(`gh-run target must look like owner/repo:<run id>, got "${target}"`);
  const r = ctx.run('gh', ['run', 'view', m[2] as string, '--repo', m[1] as string, '--json', 'status,conclusion,name']);
  if (r.status !== 0) throw new Error(`gh run view failed: ${(r.stderr || '').split('\n')[0]}`);
  const { status, conclusion, name } = JSON.parse(r.stdout) as { status: string; conclusion?: string; name?: string };
  return { status, conclusion: conclusion || '', name: name || '' };
}

export function diff(prev: GhRunState | null, next: GhRunState): WatchEvent[] {
  if (next.status === 'completed' && prev?.status !== 'completed') return [{ summary: `run "${next.name}" completed: ${next.conclusion || 'unknown'}` }];
  if (prev && prev.status !== next.status && next.status !== 'completed') return [{ summary: `run "${next.name}" is ${next.status}`, actionable: false }];
  return [];
}

export const done = (state: GhRunState): boolean => state.status === 'completed';
