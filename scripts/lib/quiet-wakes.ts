/**
 * Quiet wakes: events whose handling is mechanical are handled by the loop, so the orchestrator session is not woken for them.
 * Each rule looks at one digest event and answers `suppress` (info only, never wakes), `wake` (keep it actionable, with a logged reason and
 * optionally a better summary) or nothing (not this rule's event; the normal triage runs). Rules:
 *   - continuity: info only. The tick is silent when it works, and its failures reach the hourly triage sweep instead of waking.
 *   - merge-sweep-hourly (a `wake` watch): the loop runs the read-only `merge-sweep.ts` itself. No findings: suppress, with a ledger note.
 *     Any finding, an unknown PR, or a sweep that failed to run: wake, with the findings in the summary.
 *   - LEFT-OPEN-SET: `gh` says the PR is MERGED: suppress, with a ledger note. Closed without merging, still open, or `gh` failed: wake (fail open).
 * Everything else, and every rule when no deps are given for the two outside-world rules, is left alone. The outside world is `QuietDeps`, so tests stand in for it.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { oneLine } from './notify.ts';
import { toolCommand } from './tool-bin.ts';
import type { DigestEvent } from './types.ts';

export const MERGE_SWEEP_WATCH = 'merge-sweep-hourly';

export type SweepOutcome = { status: 'clean' } | { status: 'findings'; summary: string } | { status: 'failed'; reason: string };
export type PrState = 'MERGED' | 'CLOSED' | 'OPEN';

/** What the two outside-world rules need. `prState` returns undefined when gh could not say. */
export interface QuietDeps {
  sweep: () => SweepOutcome;
  prState: (repo: string, number: number) => PrState | undefined;
  /** Writes one ledger note; a throw is the caller's to survive (the rule suppresses only when the note was written). */
  note: (text: string) => void;
}

export type QuietVerdict =
  | { action: 'suppress'; rule: string; reason: string }
  | { action: 'wake'; rule: string; reason: string; summary?: string };

type Ev = Pick<DigestEvent, 'watch' | 'type' | 'summary'>;
const LEFT_OPEN = /^(?:\[self-review\] )?LEFT-OPEN-SET ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/;

const continuity = (e: Ev): QuietVerdict | null => (e.type === 'continuity'
  ? { action: 'suppress', rule: 'continuity-info', reason: 'continuity events are info only; the hourly sweep lists them' } : null);

/** Writes the note, then suppresses; if the note cannot be written the event wakes, so nothing is dropped without a record. */
function suppressWithNote(deps: QuietDeps, rule: string, reason: string, note: string): QuietVerdict {
  try { deps.note(note); } catch (err) { return { action: 'wake', rule, reason: `${reason}; ledger note failed (${oneLine(err instanceof Error ? err.message : String(err), 80)})` }; }
  return { action: 'suppress', rule, reason };
}

function mergeSweep(e: Ev, deps: QuietDeps): QuietVerdict | null {
  if (e.type !== 'wake' || e.watch !== MERGE_SWEEP_WATCH) return null;
  const out = deps.sweep();
  if (out.status === 'clean') return suppressWithNote(deps, 'merge-sweep-clean', 'merge-sweep ran in the loop and found nothing', 'merge-sweep (run by the event loop): no findings');
  if (out.status === 'findings') return { action: 'wake', rule: 'merge-sweep-findings', reason: 'merge-sweep found something to act on', summary: `${e.summary} | merge-sweep: ${out.summary}` };
  return { action: 'wake', rule: 'merge-sweep-failed', reason: `merge-sweep could not run (${out.reason}); waking instead`, summary: `${e.summary} | merge-sweep failed: ${out.reason}` };
}

function leftOpenSet(e: Ev, deps: QuietDeps): QuietVerdict | null {
  const m = e.type === 'pr-watch' ? LEFT_OPEN.exec(String(e.summary)) : null;
  if (!m) return null;
  const [repo, number] = [m[1] as string, Number(m[2])];
  const state = deps.prState(repo, number);
  if (state === 'MERGED') return suppressWithNote(deps, 'left-open-set-merged', `${repo}#${number} merged`, `${repo}#${number} left the open set: gh reports it merged (auto-handled by the event loop)`);
  const why = state === undefined ? 'gh could not read its state' : state === 'CLOSED' ? 'it closed without merging' : 'it is still open';
  return { action: 'wake', rule: 'left-open-set-unmerged', reason: `${repo}#${number}: ${why}` };
}

/** The first rule that has an opinion on this event, or null. `deps` undefined leaves only the rule that needs none (continuity). */
export function quietVerdict(e: Ev, deps?: QuietDeps): QuietVerdict | null {
  return continuity(e) ?? (deps ? mergeSweep(e, deps) ?? leftOpenSet(e, deps) : null);
}

const MERGE_SWEEP = fileURLToPath(new URL('../merge-sweep.ts', import.meta.url));
const JOURNAL = fileURLToPath(new URL('../journal.ts', import.meta.url));
const SWEEP_TIMEOUT_MS = 120_000;

/** The words for a non-empty merge-sweep JSON report: how many rows in each list, with the merged ids. */
function describeReport(stdout: string): string | null {
  try {
    const r = JSON.parse(stdout) as Record<string, unknown>;
    const list = (k: string): { id?: unknown }[] => (Array.isArray(r[k]) ? r[k] as { id?: unknown }[] : []);
    const parts = (['merged', 'stale', 'unknown', 'closed'] as const).filter((k) => list(k).length)
      .map((k) => `${list(k).length} ${k}${k === 'merged' ? ` (${list(k).map((x) => String(x.id)).join(', ')})` : ''}`);
    return parts.length ? parts.join(', ') : null;
  } catch { return null; }
}

/** The real outside world: `merge-sweep.ts --json` (exit 0 clean, 1 or 3 findings, anything else a failure), `gh pr view`, and `journal.ts note`. */
export function realQuietDeps(): QuietDeps {
  return {
    sweep: () => {
      const r = spawnSync(process.execPath, [MERGE_SWEEP, '--json'], { encoding: 'utf8', timeout: SWEEP_TIMEOUT_MS });
      if (r.status === 0) return { status: 'clean' };
      if (r.status === 1 || r.status === 3) return { status: 'findings', summary: oneLine(describeReport(r.stdout) ?? `exit ${r.status}, run merge-sweep.ts for the list`, 200) };
      return { status: 'failed', reason: oneLine(r.error?.message ?? `exit ${r.status}`, 80) };
    },
    prState: (repo, number) => {
      const r = spawnSync(...toolCommand('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'state']), { encoding: 'utf8', timeout: 20_000 });
      if (r.status !== 0) return undefined;
      try {
        const state = String((JSON.parse(r.stdout) as { state?: unknown }).state ?? '').toUpperCase();
        return state === 'MERGED' || state === 'CLOSED' || state === 'OPEN' ? state : undefined;
      } catch { return undefined; }
    },
    note: (text) => {
      const r = spawnSync(process.execPath, [JOURNAL, 'note', text, '--model', 'unrecorded', '--used', 'loop:continuity'], { encoding: 'utf8', timeout: 30_000 });
      if (r.status !== 0) throw new Error(`journal note exited ${r.status}`);
    },
  };
}
