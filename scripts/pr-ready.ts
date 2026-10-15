#!/usr/bin/env node
/**
 * PR READY: the way agents and the orchestrator mark a draft ready for review. Checks the review queue cap first, so the cap is enforced where a PR
 * actually joins the queue (`pr-open.ts` only ever opens drafts, and drafts are not counted), then runs `gh pr ready`.
 *
 *   node scripts/pr-ready.ts --repo <path> --pr <number> [--over-cap "<reason>"] [--dry-run] [--vault <ledger root>]
 *
 * In a repo whose owner is in `review_queue_orgs` (and that is not a `self_review_repos` repo) it refuses when the PRs waiting on reviewers are at or over
 * `review_queue_cap` (journal.ts review-queue, reference/dispatch.md#review-queue-cap), unless the PR would add nothing to the count (a staging twin of an
 * open develop PR, or a PR waiting on its author). A queue that cannot be read refuses too. Personal and self-review repos are never gated.
 * `--over-cap "<reason>"` marks it ready anyway; the reason is required, printed, and appended to `over-cap.jsonl` beside the PR snapshot.
 * Exit 0 marked ready (or dry run, or allowed), 1 refused by the cap, 2 bad usage or a git/gh error. The gh binary is `gh`, or MAESTRO_GH_BIN (tests use a stand-in).
 * The repo is identified by the checkout's origin remote, so origin must be the upstream repo: a fork or mirror as origin is a different owner and is not gated.
 * The one gap: nothing stops a hand-typed `gh pr ready` or the GitHub button; this script is the maestro path, not a GitHub-side rule.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_ROOT, REVIEW_QUEUE_CAP, REVIEW_QUEUE_ORGS, SELF_REVIEW_REPOS, VAULT_ROOT } from './local-config.ts';
import { fetchLive, freshestSnapshotPath, snapshotPath } from './prs-snapshot.ts';
import { toolCommand } from './lib/tool-bin.ts';
import { githubSlug } from './pr-open.ts';
import { readQueue, readSnapshotPrs, type QueuePr, type QueueReading } from './lib/review-queue.ts';
import { readyGate } from './lib/queue-gate.ts';

export interface ReadyArgs { repo: string; pr: number; dryRun: boolean; overCap: string; vault: string }

function usage(msg?: string): never {
  if (msg) console.error(`pr-ready: ${msg}`);
  console.error('usage: node scripts/pr-ready.ts --repo <path> --pr <number> [--over-cap "<reason>"] [--dry-run] [--vault <ledger root>]');
  process.exit(2);
}

export function parseArgs(argv: string[]): ReadyArgs {
  const o: ReadyArgs = { repo: '', pr: 0, dryRun: false, overCap: '', vault: LEDGER_ROOT || VAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--repo') o.repo = argv[++i] ?? '';
    else if (a === '--vault') o.vault = argv[++i] ?? '';
    else if (a === '--over-cap') { o.overCap = argv[++i] ?? ''; if (!o.overCap.trim() || o.overCap.startsWith('--')) usage('--over-cap needs a reason'); }
    else if (a === '--pr') { const n = argv[++i] ?? ''; if (!/^[1-9]\d*$/.test(n)) usage('--pr must be a PR number'); o.pr = Number(n); }
    else usage(`unknown argument ${a}`);
  }
  if (!o.repo || !o.pr) usage('--repo and --pr are required');
  return o;
}

/** The PR's head and base branch, from gh: what the gate needs to tell whether it is a staging twin and so adds nothing to the queue. */
function candidateOf(slug: string, pr: number): Pick<QueuePr, 'headRefName' | 'baseRefName'> {
  const [cmd, argv] = toolCommand('gh', ['pr', 'view', String(pr), '--repo', `github.com/${slug}`, '--json', 'headRefName,baseRefName']);
  const r = spawnSync(cmd, argv, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh pr view failed: ${(r.stderr || '').split('\n')[0]}`);
  return JSON.parse(r.stdout) as Pick<QueuePr, 'headRefName' | 'baseRefName'>;
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const slug = githubSlug(spawnSync('git', ['-C', o.repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout || '');
  if (!slug) usage(`${o.repo} has no github.com origin, so the repo cannot be identified`);
  const reading: QueueReading = readQueue({ fetchLive, readStored: () => readSnapshotPrs(freshestSnapshotPath(o.vault)) }, REVIEW_QUEUE_CAP, new Date(), SELF_REVIEW_REPOS, REVIEW_QUEUE_ORGS);
  let candidate: Pick<QueuePr, 'headRefName' | 'baseRefName'> = {};
  try { candidate = candidateOf(slug, o.pr); } catch (e) { console.error(`pr-ready: ${(e as Error).message}; counting the PR as one more waiting on reviewers`); }
  const v = readyGate({ repo: slug, candidate, reading, cap: REVIEW_QUEUE_CAP, selfReview: SELF_REVIEW_REPOS, owners: REVIEW_QUEUE_ORGS, overCapReason: o.overCap });
  if (!v.allow) { console.error(`pr-ready: refused, ${v.message}`); process.exit(1); }
  console.log(`pr-ready: ${v.message}`);
  if (v.overridden && !o.dryRun) logOverride(o, slug);
  const args = ['pr', 'ready', String(o.pr), '--repo', `github.com/${slug}`];
  if (o.dryRun) { console.log(`${process.env.MAESTRO_GH_BIN || 'gh'} ${args.join(' ')}`); return; }
  const [cmd, argv] = toolCommand('gh', args);
  const r = spawnSync(cmd, argv, { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, GH_REPO: '' } });
  if (r.status !== 0) process.exit(r.status ?? 2);
}

/** Appends the override to `over-cap.jsonl` beside the PR snapshot. A log that cannot be written is a warning: the override was the user's call and is already printed. */
function logOverride(o: ReadyArgs, slug: string): void {
  try {
    const path = join(dirname(snapshotPath(o.vault)), 'over-cap.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), repo: slug, pr: o.pr, reason: o.overCap, cap: REVIEW_QUEUE_CAP })}\n`);
  } catch (e) { console.error(`pr-ready: the override could not be logged: ${(e as Error).message}`); }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
