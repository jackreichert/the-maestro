#!/usr/bin/env node
/**
 * precompact.ts: the PreCompact hook. Model-free and synchronous: when it returns, a compaction may proceed and nothing the
 * summary could drop is missing from disk. Input is the hook's JSON on stdin (`transcript_path`, `trigger`).
 *
 *   precompact.ts [--project <name>] [--vault <ledger-root>]
 *
 * 1. `journal.ts handoff --all --delta` (a full handoff when none exists today).
 * 2. Copies dirty and untracked source of active worktrees to <scripts_dir>/scratch/snapshots/<date>/.
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
import { HOOK_USED, PRECOMPACT_INCOMPLETE, PRECOMPACT_MARK, snapshotDirty, unledgeredDecisions, userMessages } from '../lib/continuous-roll.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
const MARKS = ['--model', 'unrecorded', '--used', HOOK_USED];

/** Everything the hook touches outside itself; tests replace it. */
export interface PrecompactDeps {
  /** Runs journal.ts with the forwarded flags; ok false carries the reason. */
  journal: (args: string[]) => { ok: boolean; out: string };
  readLedger: () => LedgerRow[];
  readTranscript: (path: string) => string;
  snapshot: (date: string) => { worktrees: number; files: number; skipped: number } | null;
  now: () => Date;
}

export interface PrecompactInput { transcript_path?: string; trigger?: string }

/** Runs the four steps and returns the marker row's text. Never throws. */
export function precompact(input: PrecompactInput, deps: PrecompactDeps): string {
  const failed: string[] = [];
  const step = <T>(name: string, fn: () => T): T | null => {
    try { return fn(); } catch (e) { failed.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 100)}`); return null; }
  };
  step('handoff', () => { const r = deps.journal(['handoff', '--all', '--delta']); if (!r.ok) throw new Error(r.out || 'journal.ts handoff failed'); });
  const snap = step('snapshot', () => { const r = deps.snapshot(deps.now().toISOString().slice(0, 10)); if (!r) throw new Error('scripts_dir is not set'); return r; });
  let raised = 0;
  step('decisions', () => {
    if (!input.transcript_path) throw new Error('no transcript_path in the hook input');
    const rows = deps.readLedger();
    const since = rows.findLast((r) => r.kind === 'note' && (r.text ?? '').startsWith(PRECOMPACT_MARK))?.ts ?? '';
    for (const q of unledgeredDecisions(userMessages(deps.readTranscript(input.transcript_path)), rows, since)) {
      const r = deps.journal(['ask', q, ...MARKS]);
      if (!r.ok) throw new Error(r.out || 'journal.ts ask failed');
      raised++;
    }
  });
  const trigger = input.trigger ?? 'unknown';
  const text = failed.length
    ? `${PRECOMPACT_INCOMPLETE}: ${failed.join('; ')} (trigger ${trigger})`
    : `${PRECOMPACT_MARK}: handoff delta written, ${snap?.files ?? 0} file(s) snapshotted from ${snap?.worktrees ?? 0} worktree(s), ${raised} unledgered decision(s) raised (trigger ${trigger})`;
  if (!deps.journal(['log', text, '--kind', 'note', ...MARKS]).ok) console.error(`precompact hook: could not append the marker row: ${text}`);
  return text;
}

/** Value of `--name <v>` in argv, or ''. */
const flag = (argv: string[], name: string): string => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] ?? '' : ''; };

function realDeps(argv: string[]): PrecompactDeps {
  const forward = ['project', 'vault'].flatMap((f) => (flag(argv, f) ? [`--${f}`, flag(argv, f)] : []));
  const store = openStore({ vault: flag(argv, 'vault') || LEDGER_ROOT || VAULT_ROOT, project: flag(argv, 'project') || CONFIGURED_PROJECT, dryRun: false, warn: () => {} });
  return {
    journal: (args) => {
      const r = spawnSync(process.execPath, [JOURNAL, ...args, ...forward], { encoding: 'utf8', timeout: 100_000 });
      return { ok: !r.error && r.status === 0, out: (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop() ?? '' };
    },
    readLedger: () => store.readLedger(),
    readTranscript: (p) => readFileSync(p, 'utf8'),
    snapshot: (date) => (SCRIPTS_SHELF_DIR && CONTAINER_ROOT ? snapshotDirty(CONTAINER_ROOT, join(SCRIPTS_SHELF_DIR, 'scratch', 'snapshots', date)) : null),
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
