#!/usr/bin/env node
/**
 * reply-drafts.ts: the hands of the reply helper (playbooks/reply-drafts.md), for the person's OWN PRs.
 *
 *   threads --repo <owner/name> --pr <n>     print the unresolved review threads that wait on you: who wrote, human or bot, the comments
 *   submit  [--vault ..] [--project ..]      stdin: { repo, pr, replies: [{ commentId, kind, text }] }, kind fixed | decline | question
 *
 * `submit` routes by who is in the thread (lib/replies/route.ts): a thread with a person in it becomes a draft that waits for Approve, Edit or
 * Reject on the Podium's Open PRs tab; a thread with only bots in it is answered directly and, for fixed and decline, resolved.
 * It refuses a PR that is not yours.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, GH_LOGIN, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { draftsPath } from './lib/drafts/queue.ts';
import { spawnGh } from './lib/drafts/post.ts';
import type { GhRun } from './lib/drafts/post.ts';
import { routeReplies } from './lib/replies/route.ts';
import type { ReplyIn, Routed } from './lib/replies/route.ts';
import { fetchThreads, waitingThreads } from './lib/replies/threads.ts';
import { printJson } from './lib/json-out.ts';
import { toolCommand } from './lib/tool-bin.ts';

const USAGE = 'Usage: reply-drafts.ts threads --repo <owner/name> --pr <n> | submit [--vault <root>] [--project <name>] < replies.json';

function self(): string {
  if (GH_LOGIN) return GH_LOGIN;
  const [c, a] = toolCommand('gh', ['api', 'user', '--jq', '.login']);
  const r = spawnSync(c, a, { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('could not tell who you are: set gh_login');
  return r.stdout.trim();
}

/** The waiting threads on `repo#pr`, trimmed for an agent to read. Throws when the PR is not the person's own and open. */
export function threadsView(repo: string, pr: number, me: string, run: GhRun): object[] {
  const p = fetchThreads(repo, pr, me, run);
  if (p.author.toLowerCase() !== me.toLowerCase() || !p.open) throw new Error('that is not your own open PR');
  return waitingThreads(p).map((t) => ({ commentId: t.rootId, kind: t.kind, path: t.path, line: t.line, outdated: t.outdated, comments: t.comments.slice(-6).map((c) => ({ author: c.author, bot: c.bot, body: c.body.slice(0, 800) })) }));
}

/** Routes a submission; see routeReplies. */
export const submit = (file: string, s: { repo: string; pr: number; replies: ReplyIn[] }, me: string, run: GhRun = spawnGh): Routed[] => {
  if (!Array.isArray(s.replies)) throw new Error('submission needs repo, pr and replies[]');
  return routeReplies(file, { repo: s.repo, pr: s.pr, self: me, replies: s.replies, run });
};

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' }, pr: { type: 'string' }, vault: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd] = positionals;
  if (v.help || !['threads', 'submit'].includes(cmd ?? '')) { console.log(USAGE); return v.help ? 0 : 2; }
  if (cmd === 'threads') {
    if (!v.repo) { console.error(USAGE); return 2; }
    printJson(threadsView(v.repo, Number(v.pr), self(), spawnGh), { compact: true });
    return 0;
  }
  const vault = v.vault || LEDGER_ROOT || VAULT_ROOT;
  if (!vault) { console.error('Ledger root is not set. Set ledger_root or pass --vault <path>.'); return 2; }
  const raw = JSON.parse(readFileSync(0, 'utf8')) as { repo: string; pr: number; replies: ReplyIn[] };
  printJson(submit(draftsPath(vault, v.project || CONFIGURED_PROJECT || CONTAINER_PROJECT), raw, self()), { compact: true });
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`reply-drafts: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 1; }
}
