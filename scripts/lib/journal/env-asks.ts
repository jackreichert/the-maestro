/**
 * The question the worktree sweep raises for a worktree it would remove but for real environment files in it: move them into the
 * env store (see lib/env-store.ts), after which the worktree holds symlinks and the next sweep may remove it.
 *
 * Names only: the worktree path, the file names, the suggested store folder and the helper command. Never a file's contents.
 * A question is raised once: while an open question with the same text exists, the next roll writes nothing.
 */
import { fileURLToPath } from 'node:url';
import type { EnvAsk } from '../../branch-sweep.ts';
import { SYSTEM_LINK } from './ask-template.ts';
import type { AskTemplateInput } from './ask-template.ts';

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

/**
 * The fixed template of this system-generated ask: the roll raises it itself, so it carries the same sections a person's ask must
 * (what is blocked, two options with a cost, a recommendation, a link) and journal.ts checks them with the shared validator before it writes.
 */
export function envAskTemplate(ask: EnvAsk, recommend: string): AskTemplateInput {
  return {
    question: `Move ${ask.files.length === 1 ? 'the env file' : 'the env files'} in ${ask.repo} worktree ${ask.worktree} into the env store?`,
    blocked: `The roll cannot remove worktree ${ask.worktree}, so its disk space and branch stay until the real env files in it are moved.`,
    context: ['The question above carries the exact move command for each file; it prints names only, never contents.'],
    options: ['Move them now with the command in the question -- the next roll removes the worktree and the files stay in the env store', 'Leave them -- the worktree and its copy of the secrets stay on disk and the roll asks again'],
    recommend,
    links: [SYSTEM_LINK],
  };
}
