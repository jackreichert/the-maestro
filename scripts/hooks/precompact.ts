#!/usr/bin/env node
/**
 * precompact.ts: the PreCompact hook. Model-free and synchronous: when it returns, a compaction may proceed and nothing the
 * summary could drop is missing from disk. Input is the hook's JSON on stdin (`transcript_path`, `trigger`).
 *
 *   precompact.ts [--project <name>] [--vault <ledger-root>]
 *
 * 0. Appends a `note` row "precompact started" first, so a hook killed by its timeout still leaves a trace.
 * 1. Reads the whole transcript and raises every message that looks like an unledgered decision and was not raised before (the `[msg <ts> <hash>]` marker on a ledger row is the only memory), 20 messages per `ask` row, so nothing is left pending for a later run that may never come. It runs first so the asks it raises land in the handoff.
 * 2. Verifies the handoff: when the newest `--all` handoff (a single-stream one never counts) is at least as new as the newest ledger row that is not a hook or loop row (`handoffFresh`) and step 1 raised no ask, it is left alone (the raised asks are hook rows that `handoffFresh` ignores, so any ask forces the rewrite). Otherwise `journal.ts handoff --all --no-worktree-sweep --force --window <id> --out <Journal>/HANDOFF-<date>-precompact-<window>.md`: the hook's own file for this window, rewritten each run by that window only (45 s cap); another window's compaction the same day writes its own name, so `--force` never touches it.
 * 3. Copies dirty and untracked source (an allowlist of extensions, regular files only) of active worktrees to <scripts_dir>/scratch/snapshots/<date>/ (stops at 80 s). A file already held byte for byte in today's or yesterday's snapshot is not copied again.
 * 3b. Verifies the `continuity` watch is registered and the loop alive (`watchProblem`); if not, step 4 is `precompact incomplete: continuity watch: <one line with the fix>`.
 * 4. Appends a `note` row starting "precompact": the marker `prime` reads. When all three were already current it says `precompact: all current`; when it had to repair something it says what and by how much. A step that failed makes it "precompact incomplete: ...".
 *
 * Fails open: always exits 0, because a hook that blocks compaction leaves a session stuck. A failure is a loud ledger row instead.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, CONTAINER_ROOT, LEDGER_ROOT, SCRIPTS_SHELF_DIR, VAULT_ROOT } from '../local-config.ts';
import { ensureContinuity, marks, raiseDecisionsFromText, withContinuityLock } from '../lib/continuity.ts';
import { openStore } from '../lib/journal/store.ts';
import { readAutocompact, triggerTokens } from '../lib/autocompact.ts';
import type { AutocompactSetting } from '../lib/autocompact.ts';
import { AUTOCOMPACT_FLOOR } from '../local-config.ts';
import { COMPACTION_THRASH, errorLine, handoffFresh, HOOK_USED, newestHandoff, PRECOMPACT_INCOMPLETE, PRECOMPACT_MARK, PRECOMPACT_REPAIRED, PRECOMPACT_STARTED, REPAIR_ALARM_MS, snapshotDirty, thrash, unledgeredDecisions, userMessages } from '../lib/continuous-roll.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { liveContinuityWatchProblem } from '../lib/continuity-watch.ts';
import { resolveWindowId, windowEnv } from '../lib/window-id.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
/** The harness timeout is 120 s: the handoff gets 45 s, the snapshot stops scanning at 80 s, and the marker row needs the rest. */
export const HANDOFF_BUDGET_MS = 45_000;
export const SNAPSHOT_DEADLINE_MS = 80_000;
const MARKS = marks(HOOK_USED);
/** How long the hook waits for the continuity tick's lock. */
export const LOCK_WAIT_MS = 5_000;

/** Everything the hook touches outside itself; tests replace it. */
export interface PrecompactDeps {
  /** Runs journal.ts with the forwarded flags; ok false carries the reason. */
  journal: (args: string[], timeoutMs?: number) => { ok: boolean; out: string };
  /** The hook's own handoff file for one window and day: the window is in the name so two windows compacting the same day keep their own. */
  handoffPath: (date: string, window: string) => string;
  readLedger: () => LedgerRow[];
  /** The newest whole-ledger (`--all`) handoff file in the journal folder, as `newestHandoff(dir, true)` reads it; a single-stream handoff never counts. Null when there is none. */
  newestHandoff: () => { name: string; at: string } | null;
  readTranscript: (path: string) => string;
  /** Copies the snapshot until `deadline` (epoch ms); null when no scripts shelf is configured. */
  snapshot: (date: string, deadline: number) => { worktrees: number; copied: number; current: number; skipped: number; partial: boolean; capped: boolean } | null;
  now: () => Date;
  /** The continuity lock folder shared with the tick; unset runs without it. */
  lockDir?: string;
  /** The effective autocompact setting, named in a thrash row. */
  autocompact: () => AutocompactSetting;
  /** One actionable line when the continuity watch is not registered and live; null when it is. Unset skips the check. */
  watchProblem?: () => string | null;
}

export interface PrecompactInput { transcript_path?: string; trigger?: string; session_id?: string }

/** The decision scan alone: raises every unhandled decision-like message of the transcript as ask rows. Throws on a missing or unreadable transcript or a failed ask. */
export function raiseDecisions(input: PrecompactInput, deps: Pick<PrecompactDeps, 'journal' | 'readLedger' | 'readTranscript'>): { raised: number; count: number } {
  if (!input.transcript_path) throw new Error('no transcript_path in the hook input');
  return raiseDecisionsFromText(deps.readTranscript(input.transcript_path), deps, HOOK_USED);
}

/**
 * The SessionEnd entry point: only the decision scan, for the decisions typed after the last compaction (PreCompact does not
 * fire on /clear or when a session ends). No handoff, no snapshot, no started row. Fails open: it never throws, and a failure
 * leaves a `precompact incomplete: decisions: ...` row tagged with the session so prime reports it until a later success or an ack.
 * Returns the number of asks raised.
 */
export function decisionsOnly(input: PrecompactInput & { reason?: string }, deps: Pick<PrecompactDeps, 'journal' | 'readLedger' | 'readTranscript'>): number {
  const tag = `trigger session-end ${input.reason ?? 'unknown'}, session ${(input.session_id ?? 'unknown').slice(0, 8)}`;
  try {
    return raiseDecisions(input, deps).raised;
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100);
    try { deps.journal(['log', `${PRECOMPACT_INCOMPLETE}: decisions: ${why} (${tag})`, '--kind', 'note', ...MARKS]); } catch { /* fail open */ }
    return 0;
  }
}

/** The watch check as a failed-step entry; a throwing check is named, never fatal. */
function watchFailure(deps: Pick<PrecompactDeps, 'watchProblem'>): string[] {
  try {
    const p = deps.watchProblem?.();
    return p ? [`continuity watch: ${p}`] : [];
  } catch (e) {
    return [`continuity watch: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`];
  }
}

/** Runs the four steps and returns the marker row's text. Never throws. */
export function precompact(input: PrecompactInput, deps: PrecompactDeps): string {
  // The session tag pairs this run's started row with its result row, so another session's rows cannot hide a killed run.
  const trigger = `${input.trigger ?? 'unknown'}, session ${(input.session_id ?? 'unknown').slice(0, 8)}`;
  const started = deps.now().getTime();
  // First, before anything slow: if the harness kills this hook, the ledger still shows it began (prime reports a "started" row with no result).
  deps.journal(['log', `${PRECOMPACT_STARTED} (trigger ${trigger})`, '--kind', 'note', ...MARKS]);
  const date = deps.now().toISOString().slice(0, 10);
  // Compactions too close together: say so loudly, but never skip a step (a guard that skipped the handoff could lose state).
  // The transcript is read once and shared with the decision scan; a read failure here is the decisions step's to report, so this never adds a failed step.
  let cached: string | undefined;
  const rawRead = deps.readTranscript;
  const readOnce = (path: string): string => (cached ??= rawRead(path));
  deps = { ...deps, readTranscript: readOnce };
  try {
    const t = thrash(readOnce(input.transcript_path ?? ''), started);
    if (t.thrash) {
      const s = deps.autocompact();
      deps.journal(['log', `${COMPACTION_THRASH}: session ${(input.session_id ?? 'unknown').slice(0, 8)} compacted ${t.recent} time(s) in 10 min, ${Math.round(t.growth / 1000)}k growth since the last (setting ${s.pct ?? 'unset'}% of ${Math.round((s.window ?? 1_000_000) / 1000)}k = ${Math.round(triggerTokens(s) / 1000)}k, floor ${Math.round(AUTOCOMPACT_FLOOR / 1000)}k)`, '--kind', 'note', ...MARKS]);
    }
  } catch { cached = undefined; /* the decisions step reads again and names any failure */ }
  // Decisions, then the handoff, then the snapshot: the shared steps (lib/continuity.ts), in that fixed order.
  const window = resolveWindowId({ session: input.session_id, ...windowEnv() });
  // Taken so the hook and the continuity tick do not raise the same asks twice; after LOCK_WAIT_MS the hook runs anyway (a compaction must never lose its steps to a held lock).
  const steps = (): ReturnType<typeof ensureContinuity> => ensureContinuity({ decisions: () => raiseDecisions(input, deps), window, handoffPath: deps.handoffPath(date, window), date, deadlineMs: started + SNAPSHOT_DEADLINE_MS, handoffBudgetMs: HANDOFF_BUDGET_MS }, deps);
  const locked = deps.lockDir ? withContinuityLock(deps.lockDir, LOCK_WAIT_MS, steps) : { ran: false as const };
  const done = locked.ran ? locked.value : steps();
  const { raised, count, snapshot: snap } = done;
  const failed = [...done.failed, ...watchFailure(deps)];
  const handoff = done.handoff.reason;
  const handoffRepaired = done.handoff.repaired;
  const allCurrent = !handoffRepaired && !raised && !(snap?.copied ?? 0);
  const repaired = done.handoff.repaired && Number.isFinite(done.handoff.behindMs) && done.handoff.behindMs > REPAIR_ALARM_MS;
  const text = failed.length
    ? `${PRECOMPACT_INCOMPLETE}: ${failed.join('; ')} (trigger ${trigger})`
    : allCurrent
      ? `${PRECOMPACT_MARK}: all current (trigger ${trigger})`
      : `${repaired ? `${PRECOMPACT_REPAIRED},` : `${PRECOMPACT_MARK}:`} ${handoff}, snapshot copied ${snap?.copied ?? 0} (${snap?.current ?? 0} current), decisions raised ${count} in ${raised} ask(s) (trigger ${trigger})`;
  if (!deps.journal(['log', text, '--kind', 'note', ...MARKS]).ok) console.error(`precompact hook: could not append the marker row: ${text}`);
  return text;
}

/** Value of `--name <v>` in argv, or ''. */
export const flag = (argv: string[], name: string): string => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] ?? '' : ''; };

export function realDeps(argv: string[]): PrecompactDeps {
  const forward = ['project', 'vault'].flatMap((f) => (flag(argv, f) ? [`--${f}`, flag(argv, f)] : []));
  const store = openStore({ vault: flag(argv, 'vault') || LEDGER_ROOT || VAULT_ROOT, project: flag(argv, 'project') || CONFIGURED_PROJECT, dryRun: false, warn: () => {} });
  return {
    handoffPath: (date, window) => join(store.dir, `HANDOFF-${date}-precompact-${window}.md`),
    lockDir: join(store.dir, '.continuity'),
    journal: (args, timeoutMs = 20_000) => {
      const r = spawnSync(process.execPath, [JOURNAL, ...args, ...forward], { encoding: 'utf8', timeout: timeoutMs });
      return { ok: !r.error && r.status === 0, out: errorLine(r.stderr || r.stdout || r.error?.message || '') };
    },
    readLedger: () => store.readLedger(),
    newestHandoff: () => newestHandoff(store.dir, true),
    readTranscript: (p) => readFileSync(p, 'utf8'),
    snapshot: (date, deadline) => (SCRIPTS_SHELF_DIR && CONTAINER_ROOT ? snapshotDirty(CONTAINER_ROOT, join(SCRIPTS_SHELF_DIR, 'scratch', 'snapshots', date), Date.now(), deadline) : null),
    now: () => new Date(),
    autocompact: () => readAutocompact(),
    watchProblem: () => liveContinuityWatchProblem(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input: PrecompactInput = JSON.parse(readFileSync(0, 'utf8') || '{}');
    precompact(input, realDeps(process.argv.slice(2)));
  } catch (e) {
    console.error(`precompact hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
