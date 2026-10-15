#!/usr/bin/env node
/**
 * teammate-review.ts: the hands of the teammate PR helper (playbooks/teammate-review.md). The orchestrator runs it around a review agent.
 *
 *   prepare --repo <owner/name> --pr <n>     check out the PR head read-only (detached, files unwritable) and print { path, head, base, diff } as JSON
 *   firstpass --repo <o/n> --pr <n> --path <p>   print the PR body, bots' earlier findings, the CI rollup, and each changed package's test command
 *   install --repo <o/n> --path <p> --pr <n> `npm ci` (browser downloads skipped) for the changed packages, then report `git status`
 *   submit  [--vault ..] [--project ..]      stdin: { repo, pr, head, base, path, compliment, findings: [...] }; applies the lenient bar and queues ONE review draft
 *   cleanup --repo <owner/name> --path <p>   remove a prepared worktree
 *
 * It posts nothing to GitHub. `submit` only adds drafts to the approval queue (lib/drafts/queue.ts); the person approves, edits or rejects each one
 * on the Podium, and only that button posts. It refuses the person's own PRs and self-review repos at `prepare`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, CONTAINER_ROOT, GH_LOGIN, LEDGER_ROOT, SELF_REVIEW_REPOS, VAULT_ROOT } from './local-config.ts';
import { addDraft, draftsPath, listDrafts, rejectDraft } from './lib/drafts/queue.ts';
import { parseDiffLines, planReview } from './lib/teammate/bar.ts';
import type { Finding } from './lib/teammate/bar.ts';
import { firstPass, installDeps } from './lib/teammate/firstpass.ts';
import { cleanup, lock, prepare, unlock } from './lib/teammate/worktree.ts';
import type { Runner } from './lib/teammate/worktree.ts';
import { printJson } from './lib/json-out.ts';
import { toolCommand } from './lib/tool-bin.ts';

const USAGE = 'Usage: teammate-review.ts prepare --repo <owner/name> --pr <n> | submit [--vault <root>] [--project <name>] < findings.json | cleanup --repo <owner/name> --path <worktree>';
const run: Runner = (cmd, args, cwd) => {
  const [c, a] = toolCommand(cmd, args);
  const r = spawnSync(c, a, { encoding: 'utf8', cwd, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const worktreesDir = (): string => join(CONTAINER_ROOT || '.', '.worktrees');
function self(): string {
  if (GH_LOGIN) return GH_LOGIN;
  const r = run('gh', ['api', 'user', '--jq', '.login']);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('could not tell who you are: set gh_login');
  return r.stdout.trim();
}

/** What `submit` reads: the PR and head the review was of, the worktree it was read in, and the agent's compliment and findings. */
export interface Submission { repo: string; pr: number; head: string; base: string; path: string; compliment: string; findings: Finding[]; /** The PR author's login (from `prepare`), kept on the draft so the Podium's needs-you list can name them. */ author?: string }

const reviewPath = (path: string): string => {
  const root = resolve(worktreesDir());
  const p = resolve(path);
  if (resolve(p, '..') !== root || !/^review-[A-Za-z0-9_.-]+$/.test(p.slice(root.length + 1))) throw new Error('not a review worktree');
  return p;
};

/** Queues the one review draft for this head, or says why not. `diff` is the head's unified diff (what GitHub will accept inline comments on). */
export function submit(file: string, s: Submission, diff: string): { queued: { id: string } | null; problem?: string; dropped: { index: number; reason: string }[]; downgraded: number } {
  if (!/^[0-9a-f]{7,40}$/.test(s.head) || !Array.isArray(s.findings)) throw new Error('submission needs repo, pr, a hex head and findings[]');
  const plan = planReview({ repo: s.repo, pr: s.pr, head: s.head, ...(s.author ? { author: s.author } : {}) }, s.compliment, s.findings, parseDiffLines(diff));
  if (!plan.draft) return { queued: null, problem: plan.problem, dropped: plan.dropped, downgraded: plan.downgraded };
  const out = addDraft(file, plan.draft);
  // A push makes an earlier review of this PR stale: approving it would approve an old commit. Retire the ones still waiting, with the reason on record.
  if (out.created) {
    for (const d of listDrafts(file)) {
      if (d.source === 'review' && d.repo === s.repo && d.pr === s.pr && d.id !== out.id && (d.state === 'pending' || d.state === 'failed')) rejectDraft(file, d.id, `superseded by a newer push (${s.head.slice(0, 7)})`);
    }
  }
  return { queued: out.created ? { id: out.id } : null, dropped: plan.dropped, downgraded: plan.downgraded };
}

const execIn = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } => {
  const [c, a] = toolCommand(cmd, args);
  const r = spawnSync(c, a, { encoding: 'utf8', cwd, env, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' }, pr: { type: 'string' }, path: { type: 'string' }, vault: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd] = positionals;
  if (v.help || !['prepare', 'firstpass', 'install', 'submit', 'cleanup'].includes(cmd ?? '')) { console.log(USAGE); return v.help ? 0 : 2; }
  if (cmd !== 'submit') {
    if (!CONTAINER_ROOT) { console.error('container_root is not set'); return 2; }
    if (!v.repo) { console.error(USAGE); return 2; }
  }
  if (cmd === 'prepare') {
    printJson(prepare({ repo: v.repo as string, pr: Number(v.pr), self: self(), selfRepos: SELF_REVIEW_REPOS, containerRoot: CONTAINER_ROOT, worktreesDir: worktreesDir(), run }), { compact: true });
    return 0;
  }
  if (cmd === 'firstpass' || cmd === 'install') {
    const path = reviewPath(v.path ?? '');
    const fp = firstPass({ repo: v.repo as string, pr: Number(v.pr), path, run });
    if (cmd === 'firstpass') { printJson(fp, { compact: true }); return 0; }
    unlock(path);
    try { printJson(installDeps({ path, packages: fp.packages, containerRoot: CONTAINER_ROOT, exec: execIn }), { compact: true }); } finally { lock(path); }
    return 0;
  }
  if (cmd === 'cleanup') {
    cleanup({ repo: v.repo as string, path: v.path ?? '', worktreesDir: worktreesDir(), containerRoot: CONTAINER_ROOT, run });
    return 0;
  }
  const vault = v.vault || LEDGER_ROOT || VAULT_ROOT;
  if (!vault) { console.error('Ledger root is not set. Set ledger_root or pass --vault <path>.'); return 2; }
  const raw = JSON.parse(readFileSync(0, 'utf8')) as Submission;
  if (!/^[A-Za-z0-9._\/-]+$/.test(raw.base ?? '') || raw.base.startsWith('-') || !/^[0-9a-f]{40}$/.test(raw.head ?? '')) throw new Error('submission needs a base branch and a full head sha');
  const d = run('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--unified=0', `origin/${raw.base}...${raw.head}`], reviewPath(raw.path));
  if (d.status !== 0) throw new Error(`git diff failed: ${d.stderr.split('\n')[0]?.slice(0, 200)}`);
  printJson(submit(draftsPath(vault, v.project || CONFIGURED_PROJECT || CONTAINER_PROJECT), raw, d.stdout), { compact: true });
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`teammate-review: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 1; }
}
