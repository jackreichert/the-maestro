#!/usr/bin/env node
/**
 * precompact.ts: the PreCompact hook. Model-free and synchronous: when it returns, a compaction may proceed and nothing the
 * summary could drop is missing from disk. Input is the hook's JSON on stdin (`transcript_path`, `trigger`).
 *
 *   precompact.ts [--project <name>] [--vault <ledger-root>]
 *
 * 0. Appends a `note` row "precompact started" first, so a hook killed by its timeout still leaves a trace.
 * 1. `journal.ts handoff --all --no-worktree-sweep --force --out <Journal>/HANDOFF-<date>-precompact.md`: the hook's own file, rewritten each run (45 s cap).
 * 2. Copies dirty and untracked source (an allowlist of extensions, regular files only) of active worktrees to <scripts_dir>/scratch/snapshots/<date>/ (stops at 80 s).
 * 3. Reads the transcript, and appends one `ask` row per message that looks like an unledgered decision (at most three).
 * 4. Appends a `note` row starting "precompact": the marker `prime` reads. A step that failed makes it "precompact incomplete: ...".
 *
 * Fails open: always exits 0, because a hook that blocks compaction leaves a session stuck. A failure is a loud ledger row instead.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, CONTAINER_ROOT, LEDGER_ROOT, SCRIPTS_SHELF_DIR, VAULT_ROOT } from '../local-config.ts';
import { openStore } from '../lib/journal/store.ts';
import { HOOK_USED, PRECOMPACT_INCOMPLETE, PRECOMPACT_MARK, PRECOMPACT_STARTED, scanStart, snapshotDirty, unledgeredDecisions, userMessages } from '../lib/continuous-roll.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
/** The harness timeout is 120 s: the handoff gets 45 s, the snapshot stops scanning at 80 s, and the marker row needs the rest. */
export const HANDOFF_BUDGET_MS = 45_000;
export const SNAPSHOT_DEADLINE_MS = 80_000;
const MARKS = ['--model', 'unrecorded', '--used', HOOK_USED];

/** Everything the hook touches outside itself; tests replace it. */
export interface PrecompactDeps {
  /** Runs journal.ts with the forwarded flags; ok false carries the reason. */
  journal: (args: string[], timeoutMs?: number) => { ok: boolean; out: string };
  /** Where this hook writes its own handoff for a date: one file it overwrites each run, so compactions never use up the day's b..z suffixes. */
  handoffPath: (date: string) => string;
  readLedger: () => LedgerRow[];
  readTranscript: (path: string) => string;
  /** Copies the snapshot until `deadline` (epoch ms); null when no scripts shelf is configured. */
  snapshot: (date: string, deadline: number) => { worktrees: number; files: number; skipped: number; partial: boolean } | null;
  now: () => Date;
}

export interface PrecompactInput { transcript_path?: string; trigger?: string }

/** Runs the four steps and returns the marker row's text. Never throws. */
export function precompact(input: PrecompactInput, deps: PrecompactDeps): string {
  const trigger = input.trigger ?? 'unknown';
  const started = deps.now().getTime();
  // First, before anything slow: if the harness kills this hook, the ledger still shows it began (prime reports a "started" row with no result).
  deps.journal(['log', `${PRECOMPACT_STARTED} (trigger ${trigger})`, '--kind', 'note', ...MARKS]);
  const failed: string[] = [];
  const step = <T>(name: string, fn: () => T): T | null => {
    try { return fn(); } catch (e) { failed.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`); return null; }
  };
  const date = deps.now().toISOString().slice(0, 10);
  // No worktree sweep (it took minutes on a big container) and a cap on the child, so the whole hook stays under its harness timeout.
  step('handoff', () => { const r = deps.journal(['handoff', '--all', '--no-worktree-sweep', '--force', '--out', deps.handoffPath(date)], HANDOFF_BUDGET_MS); if (!r.ok) throw new Error(r.out || 'journal.ts handoff failed'); });
  const snap = step('snapshot', () => { const r = deps.snapshot(date, started + SNAPSHOT_DEADLINE_MS); if (!r) throw new Error('scripts_dir is not set'); if (r.partial) throw new Error(`time budget reached after ${r.worktrees} worktree(s)`); return r; });
  let raised = 0;
  step('decisions', () => {
    if (!input.transcript_path) throw new Error('no transcript_path in the hook input');
    const rows = deps.readLedger();
    const since = scanStart(rows);
    for (const q of unledgeredDecisions(userMessages(deps.readTranscript(input.transcript_path)), rows, since)) {
      const r = deps.journal(['ask', q, ...MARKS]);
      if (!r.ok) throw new Error(r.out || 'journal.ts ask failed');
      raised++;
    }
  });
  const text = failed.length
    ? `${PRECOMPACT_INCOMPLETE}: ${failed.join('; ')} (trigger ${trigger})`
    : `${PRECOMPACT_MARK}: handoff written, ${snap?.files ?? 0} file(s) snapshotted from ${snap?.worktrees ?? 0} worktree(s), ${raised} unledgered decision(s) raised (trigger ${trigger})`;
  if (!deps.journal(['log', text, '--kind', 'note', ...MARKS]).ok) console.error(`precompact hook: could not append the marker row: ${text}`);
  return text;
}

/** Value of `--name <v>` in argv, or ''. */
const flag = (argv: string[], name: string): string => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] ?? '' : ''; };

function realDeps(argv: string[]): PrecompactDeps {
  const forward = ['project', 'vault'].flatMap((f) => (flag(argv, f) ? [`--${f}`, flag(argv, f)] : []));
  const store = openStore({ vault: flag(argv, 'vault') || LEDGER_ROOT || VAULT_ROOT, project: flag(argv, 'project') || CONFIGURED_PROJECT, dryRun: false, warn: () => {} });
  return {
    handoffPath: (date) => join(store.dir, `HANDOFF-${date}-precompact.md`),
    journal: (args, timeoutMs = 20_000) => {
      const r = spawnSync(process.execPath, [JOURNAL, ...args, ...forward], { encoding: 'utf8', timeout: timeoutMs });
      return { ok: !r.error && r.status === 0, out: (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop() ?? '' };
    },
    readLedger: () => store.readLedger(),
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
