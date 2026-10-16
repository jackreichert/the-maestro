#!/usr/bin/env node
/**
 * approve-pr.ts: the way an agent or the user approves a PR by hand. Never `gh pr review --approve` or a raw `gh api .../reviews`: those skip the guard.
 *
 *   node scripts/approve-pr.ts --repo <owner/name> --pr <n> --head <reviewed sha> (--body <text> | --body-file <path|->) [--triage-file <path>] [--as-comment] [--dry-run]
 *
 * Runs the approve guard (lib/approve-guard.ts) against GitHub now, then posts ONE review pinned to `--head`:
 *   - the live head is not `--head` (a push landed): refused, re-review.
 *   - an open bot thread (Copilot, Aikido, any bot) has no entry in the triage file: refused, the threads are listed. Triage them (`teammate-review.ts threads` prints them)
 *     and pass `--triage-file` (a JSON list of { threadId, worthAddressing, reason, severity? }, see lib/thread-triage.ts).
 *   - a thread triaged `blocking` posts the review as a COMMENT, not an approval. Threads triaged worth addressing are listed in the body and do not block.
 * `--as-comment` posts a COMMENT review without the guard's thread rules (the way through after a refusal); the head is still pinned.
 * `--dry-run` runs the guard and prints what would be posted. Exit 0 posted (or dry run), 1 refused, 2 bad usage or a gh error.
 * The gh binary is `gh`, or the path in MAESTRO_GH_BIN (tests use a fake).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkApprove, labelOf } from './lib/approve-guard.ts';
import type { GhOut, GhRunner } from './lib/approve-guard.ts';
import { textProblem } from './lib/drafts/queue.ts';
import { triageProblem, worthSection } from './lib/thread-triage.ts';
import type { ThreadTriage } from './lib/thread-triage.ts';
import { toolCommand } from './lib/tool-bin.ts';

const USAGE = 'Usage: approve-pr.ts --repo <owner/name> --pr <n> --head <sha> (--body <text> | --body-file <path|->) [--triage-file <path>] [--as-comment] [--dry-run]';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ApproveArgs { repo: string; pr: number; head: string; body: string; triage: ThreadTriage[]; asComment: boolean; dryRun: boolean }
export type ApproveResult = { code: 0 | 1 | 2; message: string };

const spawnGh = (args: string[], input?: string): GhOut => {
  const [cmd, argv] = toolCommand('gh', args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30_000, ...(input === undefined ? {} : { input }) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Guards, then posts. `run` is the gh runner (tests pass a stub). */
export function approvePr(a: ApproveArgs, run: GhRunner = spawnGh): ApproveResult {
  if (!REPO.test(a.repo) || !Number.isSafeInteger(a.pr) || a.pr <= 0 || !/^[0-9a-f]{40}$/.test(a.head)) return { code: 2, message: `${USAGE}\n(--head is the full 40-character sha you reviewed)` };
  const bad = textProblem(a.body) ?? triageProblem(a.triage);
  if (bad) return { code: 2, message: bad };
  let event: 'APPROVE' | 'COMMENT' = 'COMMENT';
  let body = a.body;
  if (!a.asComment) {
    const v = checkApprove(run, a.repo, a.pr, a.head, a.triage);
    if (!v.ok) return { code: 1, message: `${v.message}\nNothing was posted. To post it as a comment instead, rerun with --as-comment.` };
    event = v.event;
    const section = worthSection(v.worth.map((t) => ({ label: labelOf(t), url: t.url, reason: t.reason })));
    if (section) body = `${body}\n\n${section}`;
  }
  const again = textProblem(body);
  if (again) return { code: 2, message: again };
  const payload = JSON.stringify({ commit_id: a.head, event, body });
  if (a.dryRun) return { code: 0, message: `dry run: would post a ${event} review on ${a.repo}#${a.pr} at ${a.head.slice(0, 7)}\n${body}` };
  let r: GhOut;
  try { r = run(['api', '-X', 'POST', `repos/${a.repo}/pulls/${a.pr}/reviews`, '--input', '-'], payload); } catch { r = { status: null, stdout: '', stderr: 'gh could not run' }; }
  if (r.status !== 0) return { code: 2, message: `GitHub did not accept it: ${(r.stderr.split('\n')[0] ?? '').slice(0, 200)}. Check the PR before trying again.` };
  let url = '';
  try { const u = (JSON.parse(r.stdout) as { html_url?: unknown }).html_url; if (typeof u === 'string' && u.startsWith('https://github.com/')) url = u; } catch { /* no link */ }
  return { code: 0, message: `posted a ${event} review${url ? `: ${url}` : ''}` };
}

function main(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, options: { repo: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' }, 'triage-file': { type: 'string' }, 'as-comment': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (v.help || !v.repo || !v.pr || !v.head || (v.body === undefined) === (v['body-file'] === undefined)) { console.log(USAGE); return v.help ? 0 : 2; }
  const body = v.body ?? readFileSync(v['body-file'] === '-' ? 0 : (v['body-file'] as string), 'utf8').trim();
  const triage = v['triage-file'] ? (JSON.parse(readFileSync(v['triage-file'], 'utf8')) as ThreadTriage[]) : [];
  const out = approvePr({ repo: v.repo, pr: Number(v.pr), head: v.head.toLowerCase(), body, triage, asComment: !!v['as-comment'], dryRun: !!v['dry-run'] });
  (out.code === 0 ? console.log : console.error)(out.message);
  return out.code;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`approve-pr: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 2; }
}
