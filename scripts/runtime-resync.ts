#!/usr/bin/env node
/**
 * RUNTIME RESYNC CLI: `node scripts/runtime-resync.ts [--worktree <path>] [--json]`.
 * Fast-forwards the loop daemon's worktree to origin/main and restarts it, only when clean, a pure fast-forward and CI `test` is green
 * on that commit (lib/runtime-resync.ts). Exit 0 resynced or already current, 1 refused, 2 error or no runtime worktree found.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveDeps, resyncRuntime, runtimeWorktree, type ResyncResult } from './lib/runtime-resync.ts';

/** Runs the resync for `argv`; the exit code. */
export function main(argv: string[], out: (line: string) => void = (l) => console.log(l)): number {
  const i = argv.indexOf('--worktree');
  const cwd = (i >= 0 ? argv[i + 1] : undefined) || runtimeWorktree();
  if (!cwd) { console.error('runtime-resync: no runtime worktree (pass --worktree or set MAESTRO_RUNTIME_WORKTREE)'); return 2; }
  const json = argv.includes('--json');
  const result: ResyncResult = resyncRuntime(liveDeps(cwd, json ? (l) => console.error(l) : out));
  if (json) out(JSON.stringify(result));
  return result.action === 'refused' ? 1 : result.action === 'error' ? 2 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
