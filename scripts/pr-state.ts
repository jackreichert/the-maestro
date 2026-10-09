#!/usr/bin/env node
/**
 * PR STATE: the truth about a pull request's review and merge state, read live from GitHub.
 *
 *   node scripts/pr-state.ts <owner/repo#N | https://github.com/o/r/pull/N>... [--json]
 *
 * Per PR it prints the head sha, base, draft, mergeable and mergeStateStatus, reviewDecision, each
 * reviewer's LATEST non-comment review with the commit it was on and a verdict word (APPROVED-on-head,
 * APPROVED-stale, DISMISSED, CHANGES_REQUESTED, COMMENTED-only), unresolved threads split human vs bot,
 * a check summary, a PUSH WARNING when approvals sit on the current head, and two verdict lines:
 *   READY-FOR-REVIEW: yes|no (reasons)  not a draft, zero unresolved threads, no conflicts, checks neither failing nor pending.
 *   READY-TO-MERGE: yes|no (reasons)    the above plus mergeStateStatus CLEAN, no standing CHANGES_REQUESTED and an approval on the current head.
 *
 * An empty reviewDecision does not mean "nothing to lose": a dismissed approval also reads empty, so the
 * verdicts come from the review history, not from reviewDecision. Reads fail closed: more than one page of
 * reviews or threads, or an unreadable PR, makes both verdicts no; any state it does not recognise is no. Only logins are printed, never emails.
 * Exit 0 when every PR was read, 2 on bad usage or when any PR could not be read.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Verdict = 'APPROVED-on-head' | 'APPROVED-stale' | 'DISMISSED' | 'CHANGES_REQUESTED' | 'COMMENTED-only';
export interface Ref { repo: string; number: number }
export interface Reviewer { login: string; bot: boolean; verdict: Verdict; commit: string }
export interface Thread { author: string; bot: boolean; where: string; text: string }
export interface Checks { passed: number; failed: string[]; pending: number }
export interface PrState {
  ref: string; url: string; head: string; base: string; draft: boolean; mergeable: string; mergeState: string; reviewDecision: string;
  reviewers: Reviewer[]; humanThreads: Thread[]; botThreads: Thread[]; checks: Checks;
  pushWarning: string[]; truncated: string[];
  readyForReview: boolean; reviewReasons: string[]; readyToMerge: boolean; mergeReasons: string[];
  /** Kept for existing JSON readers: the same as readyToMerge and mergeReasons. */
  ready: boolean; reasons: string[];
}

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number url headRefOid baseRefName isDraft mergeable mergeStateStatus reviewDecision
reviews(last:100){pageInfo{hasPreviousPage} nodes{state submittedAt author{login __typename} commit{oid}}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved path line comments(first:1){nodes{body author{login __typename}}}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
}}}`;

/** `owner/repo#N` or a PR URL to a ref; undefined when it is neither. */
export function parseRef(arg: string): Ref | undefined {
  const m = arg.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) || arg.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

const isBot = (a: { login?: string; __typename?: string } | null | undefined): boolean =>
  !!a && (a.__typename === 'Bot' || /\[bot\]$/i.test(a.login || '') || /copilot|aikido/i.test(a.login || ''));

/** Each reviewer's latest non-comment review (a DISMISSED one counts), else COMMENTED-only. */
export function reviewerVerdicts(reviews: any[], head: string): Reviewer[] {
  type Entry = { login: string; bot: boolean; latest?: any; commented: boolean };
  const by = new Map<string, Entry>();
  for (const r of reviews) {
    if (!r.author?.login || r.state === 'PENDING') continue;
    const e: Entry = by.get(r.author.login) || { login: r.author.login, bot: isBot(r.author), commented: false };
    by.set(r.author.login, e);
    if (r.state === 'COMMENTED') { e.commented = true; continue; }
    if (!e.latest || String(r.submittedAt) >= String(e.latest.submittedAt)) e.latest = r;
  }
  return [...by.values()].map((e) => {
    if (!e.latest) return { login: e.login, bot: e.bot, verdict: 'COMMENTED-only' as Verdict, commit: '' };
    const commit = e.latest.commit?.oid || '';
    const verdict: Verdict = e.latest.state === 'APPROVED' ? (commit === head ? 'APPROVED-on-head' : 'APPROVED-stale')
      : e.latest.state === 'DISMISSED' ? 'DISMISSED' : 'CHANGES_REQUESTED';
    return { login: e.login, bot: e.bot, verdict, commit };
  });
}

const MERGE_STATE_WORDS: Record<string, string> = {
  BLOCKED: 'GitHub reports it blocked (a required review or check is missing)', BEHIND: 'branch is behind its base', UNSTABLE: 'a non-required check is failing',
  DIRTY: 'merge conflicts', UNKNOWN: 'GitHub has not computed the merge state yet', HAS_HOOKS: 'merge state is HAS_HOOKS, not CLEAN', DRAFT: 'draft',
};
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
export function summariseChecks(nodes: any[]): Checks {
  const out: Checks = { passed: 0, failed: [], pending: 0 };
  for (const n of nodes) {
    if (n.__typename === 'StatusContext') {
      if (n.state === 'SUCCESS') out.passed++; else if (n.state === 'PENDING' || n.state === 'EXPECTED') out.pending++; else out.failed.push(n.context);
    } else if (n.status !== 'COMPLETED') out.pending++;
    else if (FAILING.has(n.conclusion)) out.failed.push(n.name);
    else out.passed++;
  }
  return out;
}

/** Turns the GraphQL pullRequest node into the state the report prints. Pure. */
export function buildState(ref: Ref, pr: any): PrState {
  const head: string = pr.headRefOid;
  const threads: Thread[] = (pr.reviewThreads?.nodes || []).filter((t: any) => !t.isResolved).map((t: any) => {
    const c = t.comments?.nodes?.[0];
    return { author: c?.author?.login || 'unknown', bot: isBot(c?.author), where: `${t.path ?? '?'}:${t.line ?? '?'}`, text: String(c?.body || '').replace(/\s+/g, ' ').slice(0, 200) };
  });
  const ctx = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const checks = summariseChecks(ctx?.nodes || []);
  const reviewers = reviewerVerdicts(pr.reviews?.nodes || [], head);
  const truncated = [
    pr.reviews?.pageInfo?.hasPreviousPage ? 'reviews' : '', pr.reviewThreads?.pageInfo?.hasNextPage ? 'threads' : '', ctx?.pageInfo?.hasNextPage ? 'checks' : '',
  ].filter(Boolean);
  const pushWarning = reviewers.filter((r) => r.verdict === 'APPROVED-on-head').map((r) => r.login);
  const reviewReasons: string[] = [];
  if (pr.isDraft) reviewReasons.push('draft');
  if (threads.length) reviewReasons.push(`${threads.length} unresolved thread(s)`);
  if (pr.mergeable === 'CONFLICTING') reviewReasons.push('merge conflicts');
  else if (pr.mergeable !== 'MERGEABLE') reviewReasons.push(`mergeable is ${pr.mergeable}`);
  if (checks.failed.length) reviewReasons.push(`checks failing: ${checks.failed.join(', ')}`);
  if (checks.pending) reviewReasons.push('checks pending');
  if (truncated.length) reviewReasons.push(`more than one page of ${truncated.join('/')}, not fully read`);
  const mergeReasons = [...reviewReasons];
  const changes = reviewers.filter((r) => r.verdict === 'CHANGES_REQUESTED').map((r) => r.login);
  if (changes.length) mergeReasons.push(`changes requested by ${changes.join(', ')}`);
  if (!reviewers.some((r) => r.verdict === 'APPROVED-on-head')) {
    mergeReasons.push(reviewers.some((r) => r.verdict === 'DISMISSED') ? 'approval dismissed by a push, waiting for a new approval'
      : reviewers.some((r) => r.verdict === 'APPROVED-stale') ? 'approval is on an older commit, waiting for a new approval' : 'waiting for an approval');
  }
  if (pr.mergeStateStatus !== 'CLEAN') mergeReasons.push(MERGE_STATE_WORDS[pr.mergeStateStatus] || `merge state is ${pr.mergeStateStatus || 'unknown'}`);
  return {
    ref: `${ref.repo}#${ref.number}`, url: pr.url, head, base: pr.baseRefName, draft: !!pr.isDraft, mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision || '(empty)', reviewers, humanThreads: threads.filter((t) => !t.bot), botThreads: threads.filter((t) => t.bot), checks,
    pushWarning, truncated, readyForReview: reviewReasons.length === 0, reviewReasons, readyToMerge: mergeReasons.length === 0, mergeReasons,
    ready: mergeReasons.length === 0, reasons: mergeReasons,
  };
}

export function render(s: PrState): string {
  const L = [`${s.ref}  head ${s.head.slice(0, 10)}  base ${s.base}  ${s.draft ? 'DRAFT' : 'ready-for-review'}`,
    `  mergeable ${s.mergeable}, mergeStateStatus ${s.mergeState}, reviewDecision ${s.reviewDecision} (empty is not "nothing to lose"; read the reviewers below)`];
  for (const r of s.reviewers) L.push(`  reviewer ${r.login}${r.bot ? ' (bot)' : ''}: ${r.verdict}${r.commit ? ` on ${r.commit.slice(0, 10)}` : ''}`);
  if (!s.reviewers.length) L.push('  reviewers: none');
  for (const [label, list] of [['human', s.humanThreads], ['bot', s.botThreads]] as const) {
    L.push(`  unresolved ${label} threads: ${list.length}`);
    for (const t of list) L.push(`    ${t.where} (${t.author}): ${t.text}`);
  }
  L.push(`  checks: ${s.checks.passed} passed, ${s.checks.failed.length} failed${s.checks.failed.length ? ` (${s.checks.failed.join(', ')})` : ''}, ${s.checks.pending} pending`);
  if (s.pushWarning.length) L.push(`PUSH WARNING: a push will dismiss ${s.pushWarning.length} approval(s): ${s.pushWarning.join(', ')}`);
  const verdict = (ok: boolean, why: string[]) => (ok ? 'yes' : `no (${why.join('; ')})`);
  L.push(`READY-FOR-REVIEW: ${verdict(s.readyForReview, s.reviewReasons)}`);
  L.push(`READY-TO-MERGE: ${verdict(s.readyToMerge, s.mergeReasons)}`);
  return L.join('\n');
}

/** Reads one PR through `gh api graphql`; throws with gh's first stderr line on failure. */
export function fetchPr(ref: Ref): any {
  const [owner, name] = ref.repo.split('/');
  const r = spawnSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${ref.number}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || 'gh failed').trim().split('\n')[0]);
  const pr = JSON.parse(r.stdout)?.data?.repository?.pullRequest;
  if (!pr) throw new Error('pull request not found');
  return pr;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const refs = args.filter((a) => a !== '--json').map((a) => ({ a, ref: parseRef(a) }));
  if (!refs.length || refs.some((r) => !r.ref)) {
    console.error('usage: pr-state.ts <owner/repo#N | PR URL>... [--json]');
    process.exit(2);
  }
  const out: unknown[] = [];
  const text: string[] = [];
  let failed = 0;
  for (const { a, ref } of refs) {
    try {
      const s = buildState(ref!, fetchPr(ref!));
      out.push(s); text.push(render(s));
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      out.push({ ref: a, error: msg, readyForReview: false, readyToMerge: false, ready: false });
      text.push(`${a}\n  could not read: ${msg}\nREADY-FOR-REVIEW: no (could not read the PR)\nREADY-TO-MERGE: no (could not read the PR)`);
    }
  }
  console.log(json ? JSON.stringify(out, null, 2) : text.join('\n\n'));
  process.exitCode = failed ? 2 : 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) main();
