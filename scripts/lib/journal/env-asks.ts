/**
 * The question the worktree sweep raises for a worktree it would remove but for real environment files in it: move them into the
 * env store (see lib/env-store.ts), after which the worktree holds symlinks and the next sweep may remove it.
 *
 * Names only: the worktree path, the file names, the suggested store folder and the helper command. Never a file's contents.
 * A question is raised once: while an open question with the same text exists, the next roll writes nothing.
 */
import { fileURLToPath } from 'node:url';
import type { EnvAsk } from '../../branch-sweep.ts';

const MOVER = fileURLToPath(new URL('../../env-store-move.ts', import.meta.url));
/** One shell word, single-quoted, so a path or file name with spaces or metacharacters pastes safely. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export const ENV_ASK_PREFIX = 'Env files stop the sweep';

/** The question text for one worktree. The project is the one the branch names, or "unknown" with PROJECT standing in the command. */
export function envAskText(ask: EnvAsk): string {
  const files = ask.files.join(', ');
  const project = ask.project ?? 'PROJECT';
  const where = ask.project ? `suggested folder ${ask.destination}/` : `project unknown (pick one: it becomes the folder under ${ask.destination.replace(/\/PROJECT$/, '')}/)`;
  const commands = ask.files.map((f) => `node ${shellQuote(MOVER)} ${shellQuote(ask.worktree)} ${shellQuote(f)} ${project}`).join(' && ');
  return `${ENV_ASK_PREFIX}: ${ask.repo} worktree ${ask.worktree} holds real env file(s) ${files}, so the sweep keeps it. Move them into the env store (${where}): ${commands}`;
}

/** The asks still to write: each distinct worktree once, skipping any whose exact text is already an open question. */
export function envAsksToRaise(asks: EnvAsk[], openTexts: Iterable<string>): { ask: EnvAsk; text: string }[] {
  const open = new Set(openTexts);
  const seen = new Set<string>();
  return asks.map((ask) => ({ ask, text: envAskText(ask) })).filter(({ text }) => {
    if (open.has(text) || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}
