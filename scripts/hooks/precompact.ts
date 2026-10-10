#!/usr/bin/env node
/**
 * precompact.ts: the PreCompact hook. Model-free and synchronous: when it returns, a compaction may proceed and nothing the
 * summary could drop is missing from disk. Input is the hook's JSON on stdin (`transcript_path`, `trigger`).
 *
 *   precompact.ts [--project <name>] [--vault <ledger-root>]
 *
 * 0. Appends a `note` row "precompact started" first, so a hook killed by its timeout still leaves a trace.
 * 1. Reads the whole transcript and raises every message that looks like an unledgered decision and was not raised before (the `[msg <ts> <hash>]` marker on a ledger row is the only memory), 20 messages per `ask` row, so nothing is left pending for a later run that may never come. It runs first so the asks it raises land in the handoff.
 * 2. Verifies the handoff: when the newest handoff is at least as new as the newest ledger row that is not a hook or loop row (`handoffFresh`), it is left alone. Otherwise `journal.ts handoff --all --no-worktree-sweep --force --window <id> --out <Journal>/HANDOFF-<date>-precompact-<window>.md`: the hook's own file for this window, rewritten each run by that window only (45 s cap); another window's compaction the same day writes its own name, so `--force` never touches it.
 * 3. Copies dirty and untracked source (an allowlist of extensions, regular files only) of active worktrees to <scripts_dir>/scratch/snapshots/<date>/ (stops at 80 s). A file already held byte for byte in today's or yesterday's snapshot is not copied again.
 * 4. Appends a `note` row starting "precompact": the marker `prime` reads. When all three were already current it says `precompact: all current`; when it had to repair something it says what and by how much. A step that failed makes it "precompact incomplete: ...".
 *
 * Fails open: always exits 0, because a hook that blocks compaction leaves a session stuck. A failure is a loud ledger row instead.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, CONTAINER_ROOT, LEDGER_ROOT, SCRIPTS_SHELF_DIR, VAULT_ROOT } from '../local-config.ts';
import { openStore } from '../lib/journal/store.ts';
import { errorLine, handoffFresh, HOOK_USED, newestHandoff, PRECOMPACT_INCOMPLETE, PRECOMPACT_MARK, PRECOMPACT_STARTED, snapshotDirty, unledgeredDecisions, userMessages } from '../lib/continuous-roll.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { resolveWindowId, windowEnv } from '../lib/window-id.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
/** The harness timeout is 120 s: the handoff gets 45 s, the snapshot stops scanning at 80 s, and the marker row needs the rest. */
export const HANDOFF_BUDGET_MS = 45_000;
export const SNAPSHOT_DEADLINE_MS = 80_000;
const MARKS = ['--model', 'unrecorded', '--used', HOOK_USED];

/** Everything the hook touches outside itself; tests replace it. */
export interface PrecompactDeps {
  /** Runs journal.ts with the forwarded flags; ok false carries the reason. */
  journal: (args: string[], timeoutMs?: number) => { ok: boolean; out: string };
  /** The hook's own handoff file for one window and day: the window is in the name so two windows compacting the same day keep their own. */
  handoffPath: (date: string, window: string) => string;
  readLedger: () => LedgerRow[];
  /** The newest handoff file of any kind in the journal folder, as `newestHandoff` reads it; null when there is none. */
  newestHandoff: () => { name: string; at: string } | null;
  readTranscript: (path: string) => string;
  /** Copies the snapshot until `deadline` (epoch ms); null when no scripts shelf is configured. */
  snapshot: (date: string, deadline: number) => { worktrees: number; copied: number; current: number; skipped: number; partial: boolean; capped: boolean } | null;
  now: () => Date;
}

export interface PrecompactInput { transcript_path?: string; trigger?: string; session_id?: string }

/** The decision scan alone: raises every unhandled decision-like message of the transcript as ask rows. Throws on a missing or unreadable transcript or a failed ask. */
export function raiseDecisions(input: PrecompactInput, deps: Pick<PrecompactDeps, 'journal' | 'readLedger' | 'readTranscript'>): { raised: number; count: number } {
  if (!input.transcript_path) throw new Error('no transcript_path in the hook input');
  const found = unledgeredDecisions(userMessages(deps.readTranscript(input.transcript_path)), deps.readLedger());
  let raised = 0;
  for (const q of found.raise) {
    const r = deps.journal(['ask', q, ...MARKS]);
    if (!r.ok) throw new Error(r.out || 'journal.ts ask failed');
    raised++;
  }
  return { raised, count: found.count };
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

/** Whole minutes, at least 1, for the marker's "N min behind". */
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/** Runs the four steps and returns the marker row's text. Never throws. */
export function precompact(input: PrecompactInput, deps: PrecompactDeps): string {
  // The session tag pairs this run's started row with its result row, so another session's rows cannot hide a killed run.
  const trigger = `${input.trigger ?? 'unknown'}, session ${(input.session_id ?? 'unknown').slice(0, 8)}`;
  const started = deps.now().getTime();
  // First, before anything slow: if the harness kills this hook, the ledger still shows it began (prime reports a "started" row with no result).
  deps.journal(['log', `${PRECOMPACT_STARTED} (trigger ${trigger})`, '--kind', 'note', ...MARKS]);
  const failed: string[] = [];
  const step = <T>(name: string, fn: () => T): T | null => {
    try { return fn(); } catch (e) { failed.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`); return null; }
  };
  const date = deps.now().toISOString().slice(0, 10);
  // Decisions first, so the asks they raise are in the ledger before the handoff is judged and written.
  const found = { raised: 0, count: 0 };
  step('decisions', () => { Object.assign(found, raiseDecisions(input, deps)); });
  const { raised, count } = found;
  // No worktree sweep (it took minutes on a big container) and a cap on the child, so the whole hook stays under its harness timeout.
  const window = resolveWindowId({ session: input.session_id, ...windowEnv() });
  let handoff = 'handoff current';
  let handoffRepaired = false;
  step('handoff', () => {
    const covered = handoffFresh(deps.readLedger(), deps.newestHandoff());
    if (covered.fresh) return;
    const r = deps.journal(['handoff', '--all', '--no-worktree-sweep', '--force', '--window', window, '--out', deps.handoffPath(date, window)], HANDOFF_BUDGET_MS);
    if (!r.ok) throw new Error(r.out || 'journal.ts handoff failed');
    handoffRepaired = true;
    handoff = Number.isFinite(covered.behindMs) ? `handoff rewritten (${minutes(covered.behindMs)} min behind)` : 'handoff rewritten (none before)';
  });
  const snap = step('snapshot', () => { const r = deps.snapshot(date, started + SNAPSHOT_DEADLINE_MS); if (!r) throw new Error('scripts_dir is not set'); if (r.partial) throw new Error(`time budget reached after ${r.worktrees} worktree(s)`); if (r.capped) throw new Error(`file or size cap reached after ${r.copied} file(s); later source was not copied`); return r; });
  const allCurrent = !handoffRepaired && !raised && !(snap?.copied ?? 0);
  const text = failed.length
    ? `${PRECOMPACT_INCOMPLETE}: ${failed.join('; ')} (trigger ${trigger})`
    : allCurrent
      ? `${PRECOMPACT_MARK}: all current (trigger ${trigger})`
      : `${PRECOMPACT_MARK}: ${handoff}, snapshot copied ${snap?.copied ?? 0} (${snap?.current ?? 0} current), decisions raised ${count} in ${raised} ask(s) (trigger ${trigger})`;
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
    journal: (args, timeoutMs = 20_000) => {
      const r = spawnSync(process.execPath, [JOURNAL, ...args, ...forward], { encoding: 'utf8', timeout: timeoutMs });
      return { ok: !r.error && r.status === 0, out: errorLine(r.stderr || r.stdout || r.error?.message || '') };
    },
    readLedger: () => store.readLedger(),
    newestHandoff: () => newestHandoff(store.dir),
    readTranscript: (p) => readFileSync(p, 'utf8'),
    snapshot: (date, deadline) => (SCRIPTS_SHELF_DIR && CONTAINER_ROOT ? snapshotDirty(CONTAINER_ROOT, join(SCRIPTS_SHELF_DIR, 'scratch', 'snapshots', date), Date.now(), deadline) : null),
    now: () => new Date(),
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
