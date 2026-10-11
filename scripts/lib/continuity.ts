import { handoffFresh, unledgeredDecisions, userMessages } from './continuous-roll.ts';
import { acquireLock, processAlive } from './status-page/lock.ts';
import type { LedgerRow } from './ledger-core.ts';

/**
 * The three continuity steps, shared by the PreCompact hook (which runs them just before a compaction) and the continuity
 * event type (which runs them every few minutes, so the hook only has to verify): raise unledgered decisions as `ask` rows,
 * keep the whole-ledger handoff at least as new as the ledger, and copy dirty worktree source to the snapshot shelf. The
 * order is fixed: decisions first, so the asks they raise are in the ledger before the handoff is judged and written.
 * Every step is independent: one that fails is named in `failed` and the others still run.
 */

/** Everything the steps touch outside themselves; the hook and the tick each fill it in, tests replace it. */
export interface ContinuityDeps {
  /** Runs journal.ts with the forwarded flags; ok false carries the reason. */
  journal: (args: string[], timeoutMs?: number) => { ok: boolean; out: string };
  readLedger: () => LedgerRow[];
  /** The newest whole-ledger (`--all`) handoff file as `newestHandoff(dir, true)` reads it; null when there is none. */
  newestHandoff: () => { name: string; at: string } | null;
  /** Copies the snapshot until `deadline` (epoch ms); null when no scripts shelf is configured. */
  snapshot: (date: string, deadline: number) => { worktrees: number; copied: number; current: number; skipped: number; partial: boolean; capped: boolean } | null;
}

export type SnapshotResult = NonNullable<ReturnType<ContinuityDeps['snapshot']>>;

export interface ContinuityInput {
  /** The decision scan for this caller (one transcript for the hook, every live one for the tick); throws when it cannot read. */
  decisions: () => { raised: number; count: number };
  /** The window id handed to `journal.ts handoff --window`. */
  window: string;
  handoffPath: string;
  /** UTC date, `YYYY-MM-DD`, for the snapshot folder. */
  date: string;
  deadlineMs: number;
  handoffBudgetMs: number;
}

export interface ContinuityResult {
  raised: number;
  count: number;
  handoff: { repaired: boolean; behindMs: number; reason: string };
  snapshot: SnapshotResult | null;
  failed: string[];
}

/** Whole minutes, at least 1, for "N min behind". */
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/** The `--model`/`--used` flags every row a caller writes carries, so the freshness check can tell its rows from work. */
export const marks = (used: string): string[] => ['--model', 'unrecorded', '--used', used];

/** Raises every unhandled decision-like message of one transcript's text as ask rows, 20 per row. Throws when an ask fails. */
export function raiseDecisionsFromText(text: string, deps: Pick<ContinuityDeps, 'journal' | 'readLedger'>, used: string): { raised: number; count: number } {
  const found = unledgeredDecisions(userMessages(text), deps.readLedger());
  let raised = 0;
  for (const q of found.raise) {
    const r = deps.journal(['ask', q, ...marks(used)]);
    if (!r.ok) throw new Error(r.out || 'journal.ts ask failed');
    raised++;
  }
  return { raised, count: found.count };
}

/** Runs the three steps and reports what each did. Never throws. */
export function ensureContinuity(input: ContinuityInput, deps: ContinuityDeps): ContinuityResult {
  const failed: string[] = [];
  const step = <T>(name: string, fn: () => T): T | null => {
    try { return fn(); } catch (e) { failed.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`); return null; }
  };
  const found = { raised: 0, count: 0 };
  step('decisions', () => { Object.assign(found, input.decisions()); });
  const { raised, count } = found;
  const handoff = { repaired: false, behindMs: 0, reason: 'handoff current' };
  // No worktree sweep (it took minutes on a big container) and a cap on the child, so the whole run stays under its caller's timeout.
  step('handoff', () => {
    const covered = handoffFresh(deps.readLedger(), deps.newestHandoff());
    // The asks this run raised are hook or loop rows, which the freshness check ignores, so a handoff generated before them does not hold them: raising anything forces the rewrite.
    if (covered.fresh && !raised) return;
    const r = deps.journal(['handoff', '--all', '--no-worktree-sweep', '--force', '--window', input.window, '--out', input.handoffPath], input.handoffBudgetMs);
    if (!r.ok) throw new Error(r.out || 'journal.ts handoff failed');
    handoff.repaired = true;
    handoff.behindMs = covered.fresh ? 0 : covered.behindMs;
    handoff.reason = covered.fresh ? `handoff rewritten (to include ${raised} raised ask(s))` : Number.isFinite(covered.behindMs) ? `handoff rewritten (${minutes(covered.behindMs)} min behind)` : 'handoff rewritten (none before)';
  });
  const snapshot = step('snapshot', () => {
    const r = deps.snapshot(input.date, input.deadlineMs);
    if (!r) throw new Error('scripts_dir is not set');
    if (r.partial) throw new Error(`time budget reached after ${r.worktrees} worktree(s)`);
    if (r.capped) throw new Error(`file or size cap reached after ${r.copied} file(s); later source was not copied`);
    return r;
  });
  return { raised, count, handoff, snapshot, failed };
}

const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Runs `fn` holding the continuity lock (a folder beside the ledger), so the tick and a PreCompact hook never write a handoff at once.
 * Waits up to `waitMs` for a live holder (0 = do not wait). Returns null when the lock was not got; a lock left by a dead process is taken over.
 */
export function withContinuityLock<T>(dir: string, waitMs: number, fn: () => T): { ran: true; value: T } | { ran: false } {
  let release: () => void;
  try { release = acquireLock(dir, { nowMs: () => Date.now(), sleep: sleepMs, pidAlive: processAlive, pid: process.pid }, { timeoutMs: waitMs, staleMs: 10 * 60_000, pollMs: 250 }); } catch { return { ran: false }; }
  try { return { ran: true, value: fn() }; } finally { release(); }
}
