#!/usr/bin/env node
/**
 * ENV STORE MOVE: moves one real environment file out of a worktree into the env store and leaves a symlink behind.
 *
 *   node scripts/env-store-move.ts <worktree> <file> <project> [--repo <name>] [--store-root <dir>] [--dry-run]
 *
 * The file lands at `<store root>/<repo>/<project>/<file>` (store root: `env_store_root`, default ~/dev-env/.env-store; repo: the
 * worktree's main checkout name). Use project `shared` for a repo-wide value. Directories it creates are mode 700 and the file keeps
 * its owner permissions only. It refuses to overwrite a store file and never prints a file's contents. A file that is already a
 * link into the store is a no-op that only refreshes the names-only manifest (`<store root>/manifest.json`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENV_STORE_ROOT } from './local-config.ts';
import { MoveRefused, moveIntoStore } from './lib/env-store.ts';

const USAGE = 'usage: env-store-move <worktree> <file> <project> [--repo <name>] [--store-root <dir>] [--dry-run]';

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };
  const valueIdx = new Set(['--repo', '--store-root'].flatMap((f) => { const i = argv.indexOf(f); return i === -1 ? [] : [i, i + 1]; }));
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
  if (positional.length !== 3) { console.error(USAGE); return 2; }
  const [worktree, file, project] = positional as [string, string, string];
  try {
    const r = moveIntoStore({ root: flag('store-root') ?? ENV_STORE_ROOT, worktree, file, project, repo: flag('repo'), dryRun: argv.includes('--dry-run') });
    const verb = { moved: 'moved', already: 'already in the store', 'would-move': 'would move' }[r.status];
    console.log(`${verb}: ${r.link} -> ${r.store}`);
    return 0;
  } catch (e) {
    console.error(`env-store-move: ${e instanceof MoveRefused ? 'refused: ' : ''}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
