/**
 * continuity: the event-loop half of the PreCompact hook. Every 5 minutes it runs the same three steps (lib/continuity.ts) the hook runs
 * just before a compaction: raise unledgered decisions from every live interactive transcript, keep the whole-ledger handoff at least as new
 * as the ledger (`<Journal>/HANDOFF-<date>-live.md`), and copy dirty worktree source to the snapshot shelf. With the tick running, a compaction
 * finds the work already done and the hook only verifies it. Target is the transcripts folder of the project (`~/.claude/projects/<slug>`).
 *
 * Silent on success. A failed step is one actionable event per new message (the alert), and the state keeps `lastOk` so the playbook can say when it last worked.
 * A run holds the continuity lock beside the ledger and does not wait for it: a hook or another tick already running makes this one skip, silently.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureContinuity, raiseDecisionsFromText, withContinuityLock } from '../lib/continuity.ts';
import { LOOP_USED, liveTranscripts } from '../lib/continuous-roll.ts';
import { realDeps } from '../hooks/precompact.ts';
import { CLAUDE_PROJECTS_DIR } from '../local-config.ts';
import { untrackedCount } from '../lib/journal/agent-drift.ts';
import { fold } from '../lib/ledger-core.ts';
import type { ContinuityDeps } from '../lib/continuity.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface ContinuityState { lastOk: string; error: string; last: string; /** Agents running that no in-flight row accounts for, as of this tick (lib/journal/agent-drift.ts); absent in a state written before the check. */ drift?: number }

export const interval = 300;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

/** The tick's own limits: well inside the 5 minute interval, so a slow run never overlaps the next. */
export const SNAPSHOT_BUDGET_MS = 60_000;
export const HANDOFF_BUDGET_MS = 45_000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`continuity target must be a transcripts folder (for example ~/.claude/projects/<project>), got "${target}"`);
}

/** The outside world; tests replace it. */
export interface ContinuityIo {
  transcripts(target: string, now: number): { path: string; text: string }[];
  deps: ContinuityDeps;
  /** The tick's own handoff file for a UTC day. */
  handoffPath: (date: string) => string;
  /** The folder holding the continuity lock. */
  lockDir: string;
  /** How many running agents the ledger does not account for; a failed check is `undefined`, never 0. */
  drift?: (now: number) => number | undefined;
}

export function realIo(): ContinuityIo {
  const deps = realDeps([]);
  const journalDir = dirname(deps.handoffPath('x', 'x'));
  return { transcripts: liveTranscripts, deps, handoffPath: (date) => join(journalDir, `HANDOFF-${date}-live.md`), lockDir: join(journalDir, '.continuity'), drift: (now) => driftCount(deps.readLedger, now) };
}

/** The untracked-agent count, or undefined when the transcripts or the ledger cannot be read (an unknown is not a zero). */
function driftCount(readLedger: ContinuityDeps['readLedger'], now: number): number | undefined {
  try { return untrackedCount(CLAUDE_PROJECTS_DIR, fold(readLedger(), null).items, now); } catch { return undefined; }
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] || 'unknown error';

export function check(target: string, ctx: Pick<CheckContext, 'now' | 'prev'>, io: ContinuityIo = realIo()): ContinuityState {
  const prev = (ctx.prev as ContinuityState | null | undefined) ?? { lastOk: '', error: '', last: '' };
  try {
    const ran = withContinuityLock(io.lockDir, 0, () => {
      const live = io.transcripts(target, ctx.now);
      const date = new Date(ctx.now).toISOString().slice(0, 10);
      return ensureContinuity({
        decisions: () => live.reduce((sum, t) => { const r = raiseDecisionsFromText(t.text, io.deps, LOOP_USED); return { raised: sum.raised + r.raised, count: sum.count + r.count }; }, { raised: 0, count: 0 }),
        window: 'live', handoffPath: io.handoffPath(date), date,
        deadlineMs: ctx.now + SNAPSHOT_BUDGET_MS, handoffBudgetMs: HANDOFF_BUDGET_MS, resumable: true,
      }, io.deps);
    });
    if (!ran.ran) return prev;
    const r = ran.value;
    const drift = io.drift?.(ctx.now);
    // An unknown count keeps the last known one, so a standing mismatch is not re-raised as new when the next read succeeds.
    const seen = drift === undefined ? (prev.drift === undefined ? {} : { drift: prev.drift }) : { drift };
    if (r.failed.length) return { ...prev, ...seen, error: r.failed.join('; ').slice(0, 300) };
    return { lastOk: new Date(ctx.now).toISOString(), error: '', last: `${r.handoff.reason}, snapshot copied ${r.snapshot?.copied ?? 0}, decisions raised ${r.raised}${drift ? `, ${drift} untracked agent${drift === 1 ? '' : 's'}` : ''}`, ...seen };
  } catch (e) {
    return { ...prev, error: firstLine(e).slice(0, 300) };
  }
}

/** Silent unless a run newly fails (a different message than last time); that one event is the alert. */
export const diff = (prev: ContinuityState | null, next: ContinuityState): WatchEvent[] => [
  ...(next.error && next.error !== prev?.error ? [{ summary: `continuity tick failed: ${next.error}`, actionable: true }] : []),
  // Once, when untracked agents first appear: a standing mismatch is the footer's line, not an event every five minutes.
  ...(next.drift && !prev?.drift ? [{ summary: `ledger drift: ${next.drift} running agent${next.drift === 1 ? ' is' : 's are'} not in the ledger; \`journal.ts start "<text>"\` for each, and install the Agent dispatch hook (hooks/print-settings-snippet.ts)`, actionable: true }] : []),
];
