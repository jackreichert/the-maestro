/**
 * cold-start-gate: the weekly check that continuous roll still holds. Target is the project name (a ledger under the configured ledger root).
 * One run is `drills/real-state-gate.ts --project <target>`: it copies the real Journal into a temp dir, runs the SessionStart hook there and
 * confirms every open item, ask and priorities file is on the context a new session would get. No model is involved and nothing real is written.
 *
 * A check is due when no run has finished on the last 7 days (state.lastRun), or the retry time has passed. A passing run is silent. A run that finds
 * missing facts, or cannot run, is retried after a day and raised as one actionable event per new message, ids and counts only (the gate never
 * prints ledger text). State { lastRun, retryAt, error, last } is the whole memory. A 1 hour check, singleton, renews, never notifies unless added with --notify.
 */
import { fileURLToPath } from 'node:url';
import type { CheckContext, Run, WatchEvent } from '../lib/types.ts';

export interface ColdStartGateState { lastRun: number; retryAt: number; error: string; last: string }

export const interval = 3600;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const RETRY_MS = 24 * 3600 * 1000;
const FOUR_WEEKS_MS = 4 * WEEK_MS;
export const defaultTtlMs = (): number => FOUR_WEEKS_MS;

const GATE = fileURLToPath(new URL('../drills/real-state-gate.ts', import.meta.url));

export function validate(target: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) throw new Error(`cold-start-gate target must be a project name (letters, digits, . _ -), got "${target}"`);
}

/** The first few distinct ids named by the gate's MISSING lines, never more than 5. */
const named = (out: string): string => [...new Set([...out.matchAll(/^\s+MISSING \S+ (?:\S+ )?(\S+)$/gm)].map((m) => m[1] as string))].slice(0, 5).join(', ');

export function check(target: string, ctx: Pick<CheckContext, 'now' | 'prev' | 'run'>): ColdStartGateState {
  const prev = (ctx.prev as ColdStartGateState | null | undefined) ?? { lastRun: 0, retryAt: 0, error: '', last: '' };
  if (ctx.now - prev.lastRun < WEEK_MS || ctx.now < prev.retryAt) return prev;
  const r = (ctx.run as Run)(process.execPath, [GATE, '--project', target]);
  const line = r.stdout.split('\n').find((l) => l.startsWith('gate-result '));
  let result: { ok?: boolean; checked?: number; missing?: number; pending?: number } | null = null;
  try { result = line ? JSON.parse(line.slice('gate-result '.length)) : null; } catch { result = null; }
  if (!result) return { ...prev, retryAt: ctx.now + RETRY_MS, error: `gate printed no result (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 120) ?? ''}` };
  if (result.ok) return { lastRun: ctx.now, retryAt: 0, error: '', last: `ok, ${result.checked ?? 0} checks, ${result.pending ?? 0} pending` };
  return { ...prev, retryAt: ctx.now + RETRY_MS, error: `${result.missing ?? '?'} facts missing from the start context (${named(r.stdout)})`.slice(0, 300) };
}

/** Silent unless a run newly fails (a different message than last time); that one event is the alert. */
export const diff = (prev: ColdStartGateState | null, next: ColdStartGateState): WatchEvent[] =>
  next.error && next.error !== prev?.error ? [{ summary: `cold-start gate failed: ${next.error}`, actionable: true }] : [];
