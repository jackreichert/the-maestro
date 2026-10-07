#!/usr/bin/env node
/**
 * BRANCH SWEEP: lists worktrees and remote branches that can be deleted, for the user to approve in a batch.
 *
 *   node scripts/branch-sweep.ts [--container <dir>] [--repo <name>] [--json] [--no-fetch] [--pr-days <n>] [--explain <branch>]
 *   node scripts/branch-sweep.ts --apply --ids <repo:hash,...> [--container <dir>] [--repo <name>]
 *   node scripts/branch-sweep.ts --apply-worktrees [--dry-run] [--container <dir>] [--repo <name>]
 *
 * Read-only by default (it runs `git fetch --prune origin` and nothing else that writes). `--apply` deletes only the
 * listed ids, re-scanning each repo first and refusing anything that no longer qualifies. Deleting is
 * `git worktree remove` (never --force) and `git push --force-with-lease=refs/heads/<branch>:<listed tip> origin :refs/heads/<branch>` (the lease makes origin refuse
 * a branch someone pushed to after the listing; that item is reported refused and the rest continue); local branches are never deleted.
 *
 * A remote branch qualifies when it is the user's own (it has commits of its own, and every one is by one of git_emails,
 * or by the repo's user.email; no commits means not the user's unless a merged PR names the branch and its tip), is not
 * protected, and is merged into every merge target. A worktree qualifies when its branch does, or its upstream (its own
 * name on origin) was deleted with nothing unpushed, and it is clean, holds no environment file (`.env*`, `ssm-*.json`: listed for you, never removed, whatever the settings) and no other ignored file worth keeping, is not a live
 * skill, is unlocked, not under a live claim and idle. "Merged" is ancestry or a merged PR for this branch (head ref and
 * tip), the twin PR (the other target's PR, from the same branch name with a -staging/-develop suffix added or removed, or
 * linked both ways) counts when the branch's own PR into the other target has exactly its tip and the twin was merged on or after that PR, has only the
 * user's commits, and (if its branch is still on origin) is still at its PR's head. Patch-equivalence alone (`git cherry`, so a squash
 * merge, but also a squash merge that was since reverted) lists the branch under Review, and --apply refuses it.
 * Any git or gh error leaves the item out, with the reason noted.
 * `--apply-worktrees` (what `journal.ts roll` runs, a standing approval) is the worktree half without the id step: it runs
 * `git worktree prune` for entries whose directory is missing, re-scans worktrees only, and removes every one that
 * qualifies, never with --force and never a branch. A detached worktree qualifies when it passes the worktree rules and its
 * HEAD is reachable from some origin ref. Right before each removal the worktree is re-read (HEAD unchanged, no modified or
 * untracked file, detached HEAD still on origin). Everything else is printed as `kept` with its reason. Remote branches
 * are untouched; they keep the listing and `--apply --ids` flow.
 * The `gh` binary is `MAESTRO_GH` if set. Settings: local-config.ts and reference/local-config.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_EMAILS, PROTECTED_BRANCHES, SWEEP_MERGE_TARGETS, SWEEP_IDLE_MINUTES, SWEEP_BUDGET_SECONDS, SWEEP_PR_DAYS, SWEEP_PROTECT_SYMLINK_DIRS, SWEEP_DISPOSABLE_IGNORED, TWIN_FLOW_REPOS, GH_LOGIN, LEDGER_ROOT, VAULT_ROOT, CONTAINER_PROJECT,
} from './local-config.ts';

/** What `run` reports for one command: success, exit status, and trimmed stdout and stderr. */
export interface CmdResult { ok: boolean; status: number | null; out: string; err: string }
/** A git call rooted at one repo: `g('rev-parse', 'HEAD')`. */
export type Git = ((...args: string[]) => CmdResult) & { repo: string };
/** A merged PR as `gh pr list --json PR_FIELDS` returns it; gh's JSON is not validated, so this is only as right as PR_FIELDS. */
export interface PrInfo {
  number: number; baseRefName: string; headRefName: string; headRefOid: string; url: string;
  body?: string; mergedAt?: string; author?: { login?: string };
}
/** Runs `gh <args>` in a repo and returns parsed JSON, or null on any failure. Tests inject their own. */
export type GhJson = (repo: string, args: string[]) => unknown;
/** A claim file under Claims/<repo>.lock. */
export interface Claim { time?: string; pid?: number; host?: string; desk?: string }
/** Everything a scan reads besides the repo itself: settings, claims, the gh runner, and caches. */
export interface SweepContext {
  emails: string[]; protectedNames: string[]; twin: string[]; targets: Record<string, string[]>; idleMinutes: number; prDays: number;
  protectDirs: string[]; disposableIgnored: string[]; claims: Map<string, Claim>; gh: GhJson; ghLogin: string; fetch: boolean;
  claimsDir?: string; gitFor?: (repo: string) => Git; worktreesOnly?: boolean; prCache?: Map<string, PrInfo[]>;
}
interface Scan { ctx: SweepContext; protectedRefs: string[]; mainline: Set<string> }
export interface Evidence { how: string; url?: string }
export interface MergedEvidence { state: 'ok' | 'review' | 'no'; per: (Evidence & { target: string })[]; weak: string[]; missing: string[] }
interface Commit { sha: string; email: string }
interface Worktree { path: string; head: string | undefined; branch: string | undefined; detached: boolean; locked: boolean; prunable: boolean }
interface Live { paths: string[]; error?: string }
/** A listed candidate: a remote branch or a worktree the user may approve for deletion. */
export interface ListedItem { id: string; repo: string; kind: 'remote-branch' | 'worktree'; name: string; why: string; prs: string[]; tip?: string; head?: string; detached?: boolean }
export type ExcludedItem = Omit<ListedItem, 'why' | 'prs'> & { reason: string };
export interface RepoScan { repo: string; items: ListedItem[]; review: ListedItem[]; excluded: ExcludedItem[]; notes: string[]; fetchFailed?: boolean }
export interface ApplyResult { id: string; done: boolean; message: string }
export interface WorktreeSweep {
  removed: { repo: string; path: string; why: string }[]; pruned: { repo: string; path: string }[];
  kept: { repo: string; path: string; reason: string }[]; notes: string[]; skipped: string[];
}
type Failure = Error & { kind?: string };
/** A rule: a named check and the reason text for when it fails. `RA` is the argument of `reason`, which is the check's own unless stated. */
interface Rule<A extends unknown[], V, RA extends unknown[] = A> { name: string; check: (...args: A) => V; reason: (...args: RA) => string }

const errorOf = (e: unknown): Failure => (e instanceof Error ? e : new Error(String(e)));

const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}): CmdResult => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
// --no-optional-locks: a scan must not refresh the index, or it would reset the idle clock it reads.
const gitIn = (repo: string): Git => Object.assign((...a: string[]) => run('git', ['--no-optional-locks', '-C', repo, ...a]), { repo });

/** `gh <args>` as parsed JSON, or null when gh is missing, unauthenticated or fails. The default for ctx.gh. */
export function ghJson(repo: string, args: string[]): unknown {
  const r = run(process.env.MAESTRO_GH || 'gh', args, { cwd: repo });
  try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
}

/** Item id: bound to the branch tip, so an id from one listing cannot delete a branch that has moved on since. */
const idOf = (repo: string, kind: string, name: string, tip: string): string => `${repo}:${createHash('sha1').update(`${repo}\0${kind}\0${name}\0${tip}`).digest('hex').slice(0, 8)}`;

/** Live claims (Claims/<repo>.lock under the ledger root), as Map repo -> claim. Stale ones (dead pid here, or over 12h) do not count. */
export function liveClaims(dir: string | undefined): Map<string, Claim> {
  const out = new Map<string, Claim>();
  if (!dir || !existsSync(dir)) return out;
  for (const n of readdirSync(dir).filter((f) => f.endsWith('.lock'))) {
    let c: Claim; try { c = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Claim; } catch { c = {}; }
    const age = c.time ? (Date.now() - Date.parse(c.time)) / 36e5 : Infinity;
    let dead = false;
    if (c.pid && c.host === hostname()) { try { process.kill(c.pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code !== 'EPERM'; } }
    if (!dead && age <= 12) out.set(n.slice(0, -5), c);
  }
  return out;
}

export function defaultContext(over: Partial<SweepContext> = {}): SweepContext {
  const claimsDir = over.claimsDir ?? process.env.MAESTRO_CLAIMS_DIR ?? ((LEDGER_ROOT || VAULT_ROOT) && join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONTAINER_PROJECT, 'Claims'));
  return {
    emails: GIT_EMAILS, protectedNames: PROTECTED_BRANCHES, twin: TWIN_FLOW_REPOS, targets: SWEEP_MERGE_TARGETS,
    idleMinutes: SWEEP_IDLE_MINUTES, prDays: SWEEP_PR_DAYS, protectDirs: SWEEP_PROTECT_SYMLINK_DIRS, disposableIgnored: SWEEP_DISPOSABLE_IGNORED, claims: liveClaims(claimsDir), gh: ghJson, ghLogin: GH_LOGIN, fetch: true, ...over,
  };
}

/** Merge targets for a repo: explicit entry, else develop + staging in twin-flow repos, else develop. Falls back to the origin default branch for a non-twin repo with no develop. */
function targetsFor(g: Git, name: string, ctx: SweepContext): { targets?: string[]; error?: string } {
  const exists = (b: string): boolean => g('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`).ok;
  const wanted = ctx.targets[name] || (ctx.twin.includes(name) ? ['develop', 'staging'] : ['develop']);
  const missing = wanted.filter((b) => !exists(b));
  if (!missing.length) return { targets: wanted };
  const head = g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');
  if (!ctx.targets[name] && !ctx.twin.includes(name) && head && exists(head)) return { targets: [head] };
  return { error: `merge target ${missing.join(', ')} not on origin` };
}

const rule = <A extends unknown[], V, RA extends unknown[] = A>(name: string, check: (...args: A) => V, reason: (...args: RA) => string): Rule<A, V, RA> => ({ name, check, reason });
const firstFailure = <C, V>(rules: Rule<[C], V>[], c: C): Rule<[C], V> | undefined => rules.find((r) => !r.check(c));

/** A git or gh call that failed. The item it was judging does not qualify; `kind` says which tool, so gh outages are noted once. */
class SweepError extends Error {
  kind: string;
  constructor(message: string, kind = 'git') { super(message); this.kind = kind; }
}
/** stdout of a git call that must succeed; any failure throws. */
function must(g: Git, ...args: string[]): string {
  const r = g(...args);
  if (!r.ok) throw new SweepError(`git ${args.slice(0, 2).join(' ')} failed: ${r.err || `exit ${r.status}`}`);
  return r.out;
}
/** `merge-base --is-ancestor`: exit 0 is yes, 1 is no, anything else is an error. */
function isAncestor(g: Git, a: string, b: string): boolean {
  const r = g('merge-base', '--is-ancestor', a, b);
  if (r.status !== 0 && r.status !== 1) throw new SweepError(`git merge-base --is-ancestor failed: ${r.err || `exit ${r.status}`}`);
  return r.status === 0;
}

/** Commits on the first-parent line of every protected ref: the mainline, which no branch owns. */
const mainlineOf = (g: Git, protectedRefs: string[]): Set<string> => new Set(protectedRefs.flatMap((p) => must(g, 'rev-list', '--first-parent', p).split('\n').filter(Boolean)));

/** The origin refs (as `origin/<name>`) that contain `commit`, in one call. Full ref names are listed, so an ambiguous short name cannot misreport. */
const containing = (g: Git, commit: string): Set<string> => new Set(must(g, 'for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes/origin').split('\n').filter(Boolean).map((f) => f.replace(/^refs\/remotes\//, '')));

/**
 * For each protected ref in `tips` that already contains `ref`: the mainline commit just before the OLDEST first-parent merge that brought `ref` in (a merge, not
 * itself reachable from `ref`, with a second or later parent that is). That is where the branch forked off, counted
 * from its first merge, so a commit it contributed in an earlier merge round, or one it picked up from another branch
 * merged before it, is not hidden by a later merge. A fast-forward has no such merge, so nothing is subtracted for it.
 * One git call: every commit the tips have and `ref` lacks is listed with its parents, so a parent that is NOT listed
 * is reachable from `ref`.
 */
function forkPoints(g: Git, ref: string, tips: string[]): string[] {
  if (!tips.length) return [];
  const parents = new Map<string, string[]>(must(g, 'rev-list', '--parents', `^${ref}`, ...tips).split('\n').filter(Boolean).map((l) => { const [sha, ...ps] = l.split(' '); return [sha, ps]; }));
  const forks = must(g, 'rev-parse', ...tips).split('\n').map((tip) => {
    const line: string[] = []; // the tip's first-parent line down to where `ref` is reachable, newest first
    for (let c = tip; parents.has(c); c = (parents.get(c) as string[])[0] as string) line.push(c);
    return line.reverse().map((c) => parents.get(c) as string[]).find(([, ...others]) => others.some((o) => !parents.has(o)))?.[0];
  });
  return [...new Set(forks.filter((f): f is string => Boolean(f)))];
}

/**
 * The branch's own non-merge commits as [{ sha, email }]. Reachable from `ref`, not from a protected ref that does
 * not already contain it, not from the mainline just before the first merge into a protected ref that does (so a branch
 * cut from a busy develop does not inherit everyone else's commits), and not on a protected mainline. `scan` carries
 * protectedRefs (every protected origin ref, glob-matched ones such as release/* included, so a back-merge branch is
 * subtracted against all of them) and mainline. A squash or rebase merge leaves the branch's commits all here; a
 * --no-ff merge keeps them here too, which is what lets a merged branch be judged by who wrote it.
 */
function ownCommits(g: Git, ref: string, scan: Scan): Commit[] {
  const { protectedRefs, mainline } = scan;
  const has = containing(g, ref);
  const outside = protectedRefs.filter((p) => !has.has(p));
  const not = [...outside, ...forkPoints(g, ref, protectedRefs.filter((p) => has.has(p)))];
  const log = must(g, 'log', '--no-merges', '--format=%H %ae', ref, ...(not.length ? ['--not', ...not] : []));
  return log.split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([sha]) => !mainline.has(sha)).map(([sha, email]) => ({ sha, email }));
}

interface OwnCtx { emails: string[]; ghLogin: string; own: Commit[]; exactPrs: () => PrInfo[] }

/** Ownership rules. A branch is the user's only when all pass; no commit of its own is never enough by itself. */
const OWNERSHIP_RULES: Rule<[OwnCtx], boolean>[] = [
  rule('emails configured', (c) => c.emails.length > 0, () => 'no author emails (git_emails or user.email)'),
  rule('has commits of its own, or an exact merged PR the user opened', (c) => c.own.length > 0 || c.exactPrs().some((p) => c.ghLogin && p.author?.login === c.ghLogin),
    () => 'no commits of its own and no merged PR with this head opened by the user (gh_login)'),
  rule('every own commit is the user\'s', (c) => c.own.every((x) => c.emails.includes(x.email)),
    (c) => `${c.own.filter((x) => !c.emails.includes(x.email)).length} of ${c.own.length} commits are by someone else`),
];

/** The user's author emails: the configured list, else the repo's own user.email. */
const emailsFor = (g: Git, ctx: SweepContext): string[] => (ctx.emails.length ? ctx.emails : [g('config', 'user.email').out]).filter(Boolean);

function isMine(g: Git, ref: string, branch: string, tip: string, scan: Scan): { ok: boolean; reason?: string } {
  const { ctx } = scan;
  const emails = emailsFor(g, ctx);
  const c: OwnCtx = { emails, ghLogin: ctx.ghLogin, own: ownCommits(g, ref, scan), exactPrs: () => exactPrs(g.repo, branch, tip, ctx) };
  const failed = firstFailure(OWNERSHIP_RULES, c);
  return failed ? { ok: false, reason: failed.reason(c) } : { ok: true };
}

const PR_FIELDS = 'number,baseRefName,headRefName,headRefOid,url,body,mergedAt,author';
const PR_PAGE = 1000; // gh search returns at most this many per query; a full page means the window may hold more
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Merged PRs whose merge date falls in [from, to] (UTC days). A full page splits the window in two, so nothing is cut off. */
function mergedWindow(repo: string, ctx: SweepContext, from: number, to: number): PrInfo[] {
  const prs = ctx.gh(repo, ['pr', 'list', '--state', 'merged', '--search', `merged:${day(from)}..${day(to)}`, '--limit', String(PR_PAGE), '--json', PR_FIELDS]);
  if (!Array.isArray(prs)) throw new SweepError('gh pr list failed: PR evidence unavailable', 'gh');
  if (prs.length < PR_PAGE || day(from) === day(to)) return prs as PrInfo[];
  const mid = from + Math.floor((to - from) / 864e5 / 2) * 864e5;
  return [...mergedWindow(repo, ctx, from, mid), ...mergedWindow(repo, ctx, mid + 864e5, to)];
}

/**
 * Merged PRs of a repo merged in the last `ctx.prDays` days (default 180), fetched once per scan in 14-day windows
 * (a plain `gh pr list --limit` is capped and sorted by creation, so it silently drops merged PRs). An older PR just
 * reads as not merged. A failed call throws.
 */
function mergedPrs(repo: string, ctx: SweepContext): PrInfo[] {
  ctx.prCache ??= new Map();
  if (!ctx.prCache.has(repo)) {
    const end = Date.parse(day(Date.now())); const start = end - (ctx.prDays ?? 180) * 864e5;
    const byNumber = new Map<number, PrInfo>();
    for (let from = start; from <= end; from += 14 * 864e5) {
      for (const p of mergedWindow(repo, ctx, from, Math.min(from + 13 * 864e5, end))) byNumber.set(p.number, p);
    }
    ctx.prCache.set(repo, [...byNumber.values()]);
  }
  return ctx.prCache.get(repo) as PrInfo[];
}

/** Merged PRs whose head ref is `name` and whose head commit is exactly `tip`. */
const exactPrs = (repo: string, name: string, tip: string, ctx: SweepContext): PrInfo[] => mergedPrs(repo, ctx).filter((p) => p.headRefName === name && p.headRefOid === tip);

/** A twin branch name differs only by a `-staging` / `-develop` suffix: `x` and `x-staging`, `x` and `x-develop`, `x-develop` and `x-staging`. */
const stem = (b: string): string => b.replace(/-(staging|develop)$/, '');
const prNumbers = (body: string | undefined): Set<number> => new Set([...(body || '').matchAll(/(?:#|\/pull\/)(\d+)/g)].map((m) => Number(m[1])));

/** Epoch ms of a PR's mergedAt, NaN when absent, so every comparison against it is false. */
const mergedAtMs = (q: PrInfo): number => Date.parse(q.mergedAt ?? '');

interface MergeCtx {
  g: Git; ref: string; name: string; tip: string; ctx: SweepContext; targets: string[]; emails: string[]; scan: Scan; exact: () => PrInfo[];
}

/** Twin PR rules: `check` gets (c, q, own) for a candidate merged PR `q` into the twin target; all must pass. */
const TWIN_RULES: Rule<[MergeCtx, PrInfo, PrInfo[]], boolean>[] = [
  rule('merged after the branch\'s own PR', (c, q, own) => own.some((p) => mergedAtMs(q) >= mergedAtMs(p)), () => 'merged before the branch\'s own PR'),
  rule('twin head commit is readable', (c, q) => c.g('cat-file', '-e', `${q.headRefOid}^{commit}`).ok, () => 'twin head commit not in this repo'),
  rule('twin branch tip matches the PR', (c, q) => {
    const r = c.g('rev-parse', '--verify', '-q', `refs/remotes/origin/${q.headRefName}`);
    return !r.ok || r.out === q.headRefOid;
  }, () => 'twin branch moved since the PR'),
  rule('every twin commit is the user\'s', (c, q) => {
    const own = ownCommits(c.g, q.headRefOid, c.scan);
    return own.length > 0 && own.every((x) => c.emails.includes(x.email));
  }, () => 'twin has commits by someone else (or none of its own)'),
];

/**
 * The twin PR of this branch for `target`: a MERGED PR into `target` from the branch's twin (a different head ref,
 * same name up to the suffix) or whose body and the branch's own PR's body link each other. It counts only when the
 * branch itself has a merged PR into another target with exactly its tip (tip-bound), and the twin passes TWIN_RULES:
 * merged on or after that PR, head commit by the user alone, and its branch (if still on origin) still at the PR's head.
 * The twin's own branch is judged separately, on this same rule. Only merged PRs are ever listed, so state is merged.
 */
function twinPr(c: MergeCtx, target: string): PrInfo | null {
  const own = c.exact().filter((p) => p.baseRefName !== target && c.targets.includes(p.baseRefName));
  if (!own.length) return null;
  const linked = (q: PrInfo): boolean => own.some((p) => prNumbers(q.body).has(p.number) && prNumbers(p.body).has(q.number));
  return mergedPrs(c.g.repo, c.ctx)
    .filter((q) => q.baseRefName === target && q.headRefName !== c.name && (stem(q.headRefName) === stem(c.name) || linked(q)))
    .find((q) => TWIN_RULES.every((r) => r.check(c, q, own))) || null;
}

/** Evidence that the branch is merged into one target; the first rule that returns evidence wins. `check` gets (c, target). */
const TARGET_RULES: Rule<[MergeCtx, string], Evidence | false | null | undefined, [Evidence]>[] = [
  rule('ancestry', (c, t) => isAncestor(c.g, c.ref, `origin/${t}`) && { how: 'ancestry' }, (ev) => ev.how),
  rule('own merged PR', (c, t) => { const pr = c.exact().find((p) => p.baseRefName === t); return pr && { how: `PR #${pr.number}`, url: pr.url }; }, (ev) => ev.how),
  rule('twin PR', (c, t) => { const pr = twinPr(c, t); return pr && { how: `twin PR #${pr.number} (${pr.headRefName})`, url: pr.url }; }, (ev) => ev.how),
];

/** Every commit has a patch-equivalent in the target. Alone this is weak: a revert of a squash merge still matches. */
function cherryEquivalent(g: Git, target: string, ref: string): boolean {
  const lines = must(g, 'cherry', target, ref).split('\n').filter(Boolean);
  return lines.length > 0 && !lines.some((l) => l.startsWith('+'));
}

/**
 * Is `ref` (branch `name`, at `tip`) merged into every target? state 'ok' (every target has ancestry or PR
 * evidence), 'review' (the rest only patch-equivalent), or 'no'. Throws on a failed git or gh call.
 */
function mergedEvidence(g: Git, ref: string, name: string, tip: string, targets: string[], scan: Scan): MergedEvidence {
  const { ctx } = scan;
  const c: MergeCtx = { g, ref, name, tip, ctx, targets, emails: emailsFor(g, ctx), scan, exact: () => exactPrs(g.repo, name, tip, ctx) };
  const per: MergedEvidence['per'] = []; const weak: string[] = []; const missing: string[] = [];
  for (const t of targets) {
    let hit: Evidence | false | null | undefined = null;
    for (const r of TARGET_RULES) { hit = r.check(c, t); if (hit) break; }
    if (hit) per.push({ target: t, ...hit });
    else if (cherryEquivalent(g, `origin/${t}`, ref)) weak.push(t);
    else missing.push(t);
  }
  return { state: missing.length ? 'no' : weak.length ? 'review' : 'ok', per, weak, missing };
}

const why = (ev: MergedEvidence): string => `merged into ${[...ev.per.map((p) => `${p.target} (${p.how})`), ...ev.weak.map((t) => `${t} (patch-equivalent only)`)].join(' and ')}`;
const links = (ev: MergedEvidence): string[] => ev.per.filter((p) => p.url).map((p) => p.url as string);

/** Linked worktrees of a repo: [{ path, head, branch, detached, locked, prunable }]; the main worktree and bare entries are left out. Throws if git cannot list them. */
function worktrees(g: Git): Worktree[] {
  const blocks = must(g, 'worktree', 'list', '--porcelain').split('\n\n').slice(1);
  return blocks.map((b): Omit<Worktree, 'path'> & { path: string | undefined } => {
    const f = (k: string): string | undefined => b.split('\n').find((l) => l === k || l.startsWith(`${k} `));
    return { path: f('worktree')?.slice(9), head: f('HEAD')?.slice(5), branch: f('branch')?.replace('branch refs/heads/', ''), detached: !!f('detached'), locked: !!f('locked'), prunable: !!f('prunable') };
  }).filter((w): w is Worktree => Boolean(w.path && (w.branch || w.detached)));
}

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** Real targets of the symlinks in the skill dirs: the checkouts live skills are loaded from. Throws if a dir cannot be read. */
function liveSkillTargets(repoPath: string, ctx: SweepContext): string[] {
  const dirs = [join(homedir(), '.claude', 'skills'), join(dirname(repoPath), '.claude', 'skills'), ...(ctx.protectDirs || []).map(expandHome)];
  return dirs.flatMap((d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw new Error(`cannot read skill dir ${d} (${code})`);
    }
    return entries.filter((e) => e.isSymbolicLink()).flatMap((e) => {
      try { return [realpathSync(join(d, e.name))]; } catch { return []; } // a dangling link points at nothing a worktree could be
    });
  });
}

/** Worktree rules, in order: the first that fails keeps the worktree. `check` gets { g, w, repoName, ctx, live, status }. */
interface WorktreeCtx {
  g: Git; w: Worktree; repoName: string; ctx: SweepContext; live: Live; statusError: string; real: string;
  tracked: string[]; untracked: string[]; envFiles: string[]; keptIgnored: string[]; idle: number;
}

/**
 * True for an environment or secrets-export file by name (`.env`, `.env.local`, `ssm-*.json`; templates such as `.env.example` are not).
 * An ignored one may be the only copy of its secrets, so no setting makes a worktree holding one disposable.
 */
export function isEnvFile(path: string): boolean {
  const name = basename(path.replace(/\/+$/, ''));
  if (/^ssm-.*\.json$/.test(name)) return true;
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);
}

const WORKTREE_RULES: Rule<[WorktreeCtx], boolean>[] = [
  rule('not locked', (c) => !c.w.locked, () => 'locked'),
  rule('directory present', (c) => !c.w.prunable && existsSync(c.w.path), () => 'directory missing: run git worktree prune'),
  rule('no live claim', (c) => !c.ctx.claims.get(c.repoName), (c) => `repo claimed by ${c.ctx.claims.get(c.repoName)?.desk || 'a desk'}`),
  rule('skill dirs readable', (c) => !c.live.error, (c) => c.live.error as string),
  rule('not a live skill', (c) => !c.live.paths.some((t) => t === c.real || t.startsWith(c.real + sep)), () => 'a skill directory symlinks into it: live skill'),
  rule('status readable', (c) => !c.statusError, (c) => `cannot read status: ${c.statusError}`),
  rule('no uncommitted changes', (c) => c.tracked.length === 0, (c) => `uncommitted changes (${c.tracked.length} files)`),
  rule('no untracked files', (c) => c.untracked.length === 0, (c) => `${c.untracked.length} untracked files`),
  rule('no environment files', (c) => c.envFiles.length === 0,
    (c) => `${c.envFiles.length} environment files (${c.envFiles.slice(0, 3).join(', ')}${c.envFiles.length > 3 ? ', ...' : ''}): may be the only copy, listed for you to decide`),
  rule('no ignored files worth keeping', (c) => c.keptIgnored.length === 0,
    (c) => `${c.keptIgnored.length} ignored files kept (${c.keptIgnored.slice(0, 3).join(', ')}${c.keptIgnored.length > 3 ? ', ...' : ''}): not disposable`),
  rule('idle', (c) => c.idle >= c.ctx.idleMinutes, (c) => `modified ${Math.round(c.idle)} min ago (idle window ${c.ctx.idleMinutes})`),
];

function worktreeBlocker(g: Git, w: Worktree, repoName: string, ctx: SweepContext, live: Live): string | null {
  const wg = existsSync(w.path) ? gitIn(w.path) : null;
  const status: CmdResult = wg ? wg('status', '--porcelain', '--untracked-files=all', '--ignored=matching') : { ok: true, status: 0, out: '', err: '' };
  const lines = status.out.split('\n').filter(Boolean);
  const disposable = new Set(ctx.disposableIgnored || []);
  const ignored = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(3));
  const gitDir = wg ? wg('rev-parse', '--absolute-git-dir').out : '';
  const stamps = wg ? [w.path, `${gitDir}/HEAD`, `${gitDir}/index`, `${gitDir}/logs/HEAD`].filter(existsSync).map((p) => statSync(p).mtimeMs) : [];
  const c: WorktreeCtx = {
    g, w, repoName, ctx, live, statusError: status.ok ? '' : status.err || 'git status failed', real: wg ? realpathSync(w.path) : w.path,
    tracked: lines.filter((l) => !l.startsWith('??') && !l.startsWith('!!')), untracked: lines.filter((l) => l.startsWith('??')),
    envFiles: ignored.filter(isEnvFile),
    keptIgnored: ignored.filter((p) => !isEnvFile(p) && !p.split('/').some((seg) => disposable.has(seg))),
    idle: stamps.length ? (Date.now() - Math.max(...stamps)) / 6e4 : 0, // no timestamps readable: treat as just touched
  };
  const failed = WORKTREE_RULES.find((r) => !r.check(c));
  return failed ? failed.reason(c) : null;
}

/** Branch names compared as git resolves them: a `refs/heads/` or `origin/` prefix does not make `develop` a different branch. */
const bare = (b: string): string => b.replace(/^(refs\/heads\/|refs\/remotes\/|origin\/)+/, '');

const escapeRe = (t: string): string => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** A branch glob as a RegExp over the whole name: `*` stays inside one path segment, `**` crosses them, anything else is literal. */
export const branchGlob = (glob: string): RegExp => new RegExp(`^${glob.split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*')).join('.*')}$`);

/**
 * What counts as protected in one repo: the configured patterns (globs), the merge targets and the default branch.
 * { isProtected(branch), protectedRefs: the origin refs that match (as `origin/<name>`), refs: every origin ref }.
 * Throws if git cannot list the refs.
 */
function protection(g: Git, ctx: SweepContext, targets: string[]): { isProtected: (b: string) => boolean; refs: string[]; protectedRefs: string[] } {
  const head = g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');
  const matchers = [...ctx.protectedNames, ...targets, head].filter(Boolean).map(branchGlob);
  const isProtected = (b: string): boolean => matchers.some((re) => re.test(b) || re.test(bare(b)));
  const refs = must(g, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n').filter(Boolean);
  const names = refs.map((f) => f.slice('refs/remotes/origin/'.length)).filter((b) => b !== 'HEAD');
  const protectedRefs = names.filter(isProtected).map((b) => `origin/${b}`);
  return { isProtected, refs, protectedRefs };
}

/** One branch judged: { tip, mine, reason, ev, error }. Evidence is only sought for a branch that is the user's. */
interface Assessment { tip: string | null; mine: boolean; reason: string; ev: MergedEvidence | null; error: Failure | null }
function assess(g: Git, ref: string, branch: string, targets: string[], scan: Scan): Assessment {
  const a: Assessment = { tip: null, mine: false, reason: '', ev: null, error: null };
  try {
    a.tip = must(g, 'rev-parse', ref);
    const own = isMine(g, ref, branch, a.tip, scan);
    a.mine = own.ok; a.reason = own.reason || '';
  } catch (e) { a.error = errorOf(e); return a; }
  if (!a.mine) return a;
  try { a.ev = mergedEvidence(g, ref, branch, a.tip as string, targets, scan); } catch (e) { a.error = errorOf(e); }
  return a;
}

/** Records why an item was skipped: a git error names the item, a gh outage is noted once per repo. */
function noteError(res: RepoScan, e: Failure, label: string): void {
  const msg = e.kind === 'gh' ? `${e.message}; branches needing it were skipped` : `${label} skipped: ${e.message}`;
  if (!res.notes.includes(msg)) res.notes.push(msg);
}

/** Scans one repo: { repo, items: qualifying, review: cherry-only, excluded: worktrees that fail a check, notes }. */
export function scanRepo(repoPath: string, ctx: SweepContext): RepoScan {
  const name = basename(repoPath);
  const g = (ctx.gitFor || gitIn)(repoPath);
  const res: RepoScan = { repo: name, items: [], review: [], excluded: [], notes: [] };
  if (!g('remote', 'get-url', 'origin').ok) { res.notes.push('no origin remote'); return res; }
  if (ctx.fetch && !g('fetch', '--prune', 'origin').ok) { res.notes.push('git fetch failed; using the refs already here'); res.fetchFailed = true; }
  const { targets: found, error } = targetsFor(g, name, ctx);
  if (error) { res.notes.push(error); return res; }
  const targets = found as string[];
  let live: Live; try { live = { paths: liveSkillTargets(repoPath, ctx) }; } catch (e) { live = { paths: [], error: errorOf(e).message }; }
  let scan: Scan; let refs: string[]; let wts: Worktree[]; let isProtected: (b: string) => boolean;
  try {
    const prot = protection(g, ctx, targets);
    ({ isProtected, refs } = prot);
    scan = { ctx, protectedRefs: prot.protectedRefs, mainline: mainlineOf(g, prot.protectedRefs) };
    wts = worktrees(g);
  } catch (e) { res.notes.push(`scan stopped: ${errorOf(e).message}`); return res; }

  for (const full of ctx.worktreesOnly ? [] : refs) {
    const branch = full.slice('refs/remotes/origin/'.length);
    if (full === 'refs/remotes/origin/HEAD' || isProtected(branch)) continue;
    const a = assess(g, full, branch, targets, scan);
    if (a.error) { noteError(res, a.error, `branch ${branch}`); continue; }
    if (!a.ev || a.ev.state === 'no') continue;
    (a.ev.state === 'ok' ? res.items : res.review).push({ id: idOf(name, 'remote-branch', branch, a.tip as string), repo: name, kind: 'remote-branch', name: branch, tip: a.tip as string, why: why(a.ev), prs: links(a.ev) });
  }
  for (const w of wts) {
    if (w.detached) scanDetached({ g, w, name, scan, live, res });
    else if (!isProtected(w.branch as string)) scanWorktree({ g, w, name, targets, scan, live, res });
  }
  return res;
}

/** Why a worktree whose branch is not merged stays: the branch's state first, then anything uncommitted or in use. */
function unmergedReason(g: Git, w: Worktree, name: string, scan: Scan, live: Live, a: Assessment, ahead: number | null): string {
  const own = !a.mine ? `branch ${w.branch} is not yours (${a.reason})`
    : ahead === null ? `branch ${w.branch} is not merged and git could not count what is unpushed`
      : ahead > 0 ? `branch ${w.branch} has ${ahead} unpushed commit(s)`
        : `branch ${w.branch} is pushed but not merged into ${(a.ev as MergedEvidence).missing.join(', ')}`;
  const blocker = worktreeBlocker(g, w, name, scan.ctx, live);
  return blocker ? `${own}; ${blocker}` : own;
}

/**
 * One detached worktree. It qualifies when HEAD is reachable from some origin ref (so nothing is lost with it) and it
 * passes every worktree rule; no branch exists to judge, and no merge evidence is needed.
 */
function scanDetached({ g, w, name, scan, live, res }: { g: Git; w: Worktree; name: string; scan: Scan; live: Live; res: RepoScan }): void {
  const base = { id: idOf(name, 'worktree', w.path, w.head || 'unknown'), repo: name, kind: 'worktree' as const, name: w.path, head: w.head, detached: true };
  const short = (w.head || '').slice(0, 9);
  const ahead = w.head ? unpushedCount(g, w.head) : null;
  const reason = ahead === null ? `detached HEAD ${short}: git could not count what is not on origin`
    : ahead > 0 ? `detached HEAD ${short} holds ${ahead} commit(s) not on any origin ref` : '';
  const blocker = reason ? null : worktreeBlocker(g, w, name, scan.ctx, live);
  if (reason || blocker) { res.excluded.push({ ...base, reason: reason || (blocker as string) }); return; }
  res.items.push({ ...base, why: `detached at ${short}, reachable from origin`, prs: [] });
}

/** Commits of `ref` that no origin ref contains, or null when git cannot count them. */
function unpushedCount(g: Git, ref: string): number | null {
  const r = g('rev-list', '--count', ref, '--not', '--remotes=origin');
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : null;
}

/** One linked worktree: qualifies on its branch (or a deleted upstream with nothing unpushed), then must pass every worktree rule. */
function scanWorktree({ g, w, name, targets, scan, live, res }: { g: Git; w: Worktree; name: string; targets: string[]; scan: Scan; live: Live; res: RepoScan }): void {
  const ref = `refs/heads/${w.branch}`;
  const a = assess(g, ref, w.branch as string, targets, scan);
  const base = { id: idOf(name, 'worktree', w.path, a.tip || 'unknown'), repo: name, kind: 'worktree' as const, name: w.path, head: w.head };
  // Gone means the branch tracks its own name on origin and that ref was deleted; `-b x origin/develop` tracks develop.
  const gone = g('config', `branch.${w.branch}.remote`).out === 'origin' && g('config', `branch.${w.branch}.merge`).out === ref
    && !g('rev-parse', '--verify', '-q', `refs/remotes/origin/${w.branch}`).ok;
  const count = g('rev-list', '--count', ref, '--not', '--remotes');
  const ahead = count.ok && /^\d+$/.test(count.out) ? Number(count.out) : null;
  const goneClean = a.mine && gone && ahead === 0;
  const state = a.ev?.state;
  if (state !== 'ok' && !goneClean) {
    const reason = (gone && ahead === null && `branch ${w.branch} is gone from origin and git could not count what is unpushed`)
      || (gone && `branch ${w.branch} is gone from origin but ${ahead} commit(s) are not pushed or merged`)
      || (a.error && `skipped: ${a.error.message}`);
    if (reason) res.excluded.push({ ...base, reason });
    if (reason || state !== 'review') {
      if (!reason) res.excluded.push({ ...base, reason: unmergedReason(g, w, name, scan, live, a, ahead) });
      return;
    }
  }
  const blocker = worktreeBlocker(g, w, name, scan.ctx, live);
  if (blocker) { res.excluded.push({ ...base, reason: blocker }); return; }
  if (state === 'ok') res.items.push({ ...base, why: `branch ${w.branch}: ${why(a.ev as MergedEvidence)}`, prs: links(a.ev as MergedEvidence) });
  else if (goneClean) res.items.push({ ...base, why: `branch ${w.branch} deleted on origin, nothing unpushed`, prs: [] });
  else if (state === 'review') res.review.push({ ...base, why: `branch ${w.branch}: ${why(a.ev as MergedEvidence)}`, prs: links(a.ev as MergedEvidence) });
}

/** Runs a rule list's checks one by one and prints each verdict; a thrown git or gh error prints as the verdict. */
const verdict = <A extends unknown[], V extends boolean | Evidence | null | undefined, RA extends unknown[]>(label: string, r: Rule<A, V, RA>, ...args: A): string => {
  try {
    const v = r.check(...args);
    const how = v && typeof v === 'object' ? v.how : '';
    // reason takes the check's own arguments, except for TARGET_RULES, whose reason is never reached: it only runs with exactly one.
    return `  ${v ? 'PASS' : 'FAIL'} ${label}${how ? `: ${how}` : ''}${!v && args.length === 1 ? ` (${r.reason(...(args as unknown as RA))})` : ''}`;
  } catch (e) { return `  ERROR ${label}: ${errorOf(e).message}`; }
};

/** Per-rule verdicts for one remote branch, for --explain: ownership, then every target rule, then the overall result. Read-only. */
export function explain(repoPath: string, ctx: SweepContext, branch: string): string[] {
  const g = (ctx.gitFor || gitIn)(repoPath);
  const out = [`${basename(repoPath)} ${branch}`];
  if (ctx.fetch && !g('fetch', '--prune', 'origin').ok) out.push('  note: git fetch failed; using the refs already here');
  const ref = `refs/remotes/origin/${branch}`;
  if (!g('rev-parse', '--verify', '-q', ref).ok) return [...out, '  not on origin'];
  const { targets: found, error } = targetsFor(g, basename(repoPath), ctx);
  if (error) return [...out, `  ${error}`];
  const targets = found as string[];
  let prot;
  try { prot = protection(g, ctx, targets); } catch (e) { return [...out, `  ERROR ${errorOf(e).message}`]; }
  if (prot.isProtected(branch)) return [...out, '  FAIL protected branch'];
  try {
    const tip = must(g, 'rev-parse', ref);
    const emails = emailsFor(g, ctx);
    const scan = { ctx, protectedRefs: prot.protectedRefs, mainline: mainlineOf(g, prot.protectedRefs) };
    const own = ownCommits(g, ref, scan);
    const c: OwnCtx = { emails, ghLogin: ctx.ghLogin, own, exactPrs: () => exactPrs(g.repo, branch, tip, ctx) };
    out.push(`  tip ${tip.slice(0, 9)}, ${own.length} own commits, targets ${targets.join('+')}, PR look-back ${ctx.prDays ?? 180} days, ${mergedPrs(g.repo, ctx).length} merged PRs read`);
    out.push(`  exact PRs (head ${branch} at tip): ${c.exactPrs().map((p) => `#${p.number}->${p.baseRefName}`).join(', ') || 'none'}`);
    out.push('ownership:', ...OWNERSHIP_RULES.map((r) => verdict(r.name, r, c)));
    const tc: MergeCtx = { g, ref, name: branch, tip, ctx, targets, emails, scan, exact: c.exactPrs };
    for (const t of targets) {
      out.push(`target ${t}:`, ...TARGET_RULES.map((r) => verdict(r.name, r, tc, t)));
      try { out.push(`  ${cherryEquivalent(g, `origin/${t}`, ref) ? 'PASS' : 'FAIL'} patch-equivalent (review only)`); } catch (e) { out.push(`  ERROR cherry: ${errorOf(e).message}`); }
    }
    const a = assess(g, ref, branch, targets, scan);
    out.push(`result: ${a.error ? `skipped (${a.error.message})` : !a.mine ? `not mine (${a.reason})` : (a.ev as MergedEvidence).state === 'ok' ? `CANDIDATE, ${why(a.ev as MergedEvidence)}` : (a.ev as MergedEvidence).state === 'review' ? 'REVIEW' : `not merged into ${(a.ev as MergedEvidence).missing.join(', ')}`}`);
  } catch (e) { out.push(`  ERROR ${errorOf(e).message}`); }
  return out;
}

/** Git repos directly under the container (linked worktrees, whose .git is a file, are reached through their main repo). */
export function findRepos(container: string, only?: string | null): string[] {
  return readdirSync(container, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && (!only || d.name === only))
    .map((d) => join(container, d.name)).filter((p) => statSync(join(p, '.git'), { throwIfNoEntry: false })?.isDirectory());
}

/**
 * Deletes a remote branch only if origin still has it at `item.tip` (the tip the id was bound to): a push that landed after
 * the listing makes git refuse the delete (a stale-info lease), and that is reported for this branch alone.
 */
export function deleteRemoteBranch(path: string, item: { name: string; kind: string; tip?: string }, id: string): ApplyResult {
  const tip = item.tip as string;
  const ref = `refs/heads/${item.name}`;
  const r = run('git', ['-C', path, 'push', `--force-with-lease=${ref}:${tip}`, 'origin', `:${ref}`]);
  if (r.ok) return { id, done: true, message: `deleted ${item.kind} ${item.name}` };
  // Classify by asking origin, not by parsing git's (localized) message: a deleted and a moved branch both read "stale info".
  const now = run('git', ['-C', path, 'ls-remote', 'origin', ref]);
  if (!now.ok) return { id, done: false, message: `failed: ${r.err}` };
  const sha = now.out.split(/\s+/)[0];
  if (!sha) return { id, done: true, message: `${item.kind} ${item.name} was already gone from origin` };
  if (sha !== tip) return { id, done: false, message: `refused: ${item.name} moved on origin since it was listed (now ${sha.slice(0, 9)}, listed ${tip.slice(0, 9)})` };
  return { id, done: false, message: `failed: ${r.err}` };
}

/** Deletes the listed ids after re-scanning; returns [{ id, done, message }]. Anything no longer qualifying is refused. */
export function apply(ids: string[], container: string, ctx: SweepContext, only?: string | null): ApplyResult[] {
  const scans = new Map<string, RepoScan>();
  return ids.map((id) => {
    const repo = id.slice(0, id.lastIndexOf(':'));
    if (only && repo !== only) return { id, done: false, message: `not in --repo ${only}` };
    const path = join(container, repo);
    if (!findRepos(container, repo).length) return { id, done: false, message: `no repo ${repo} in the container` };
    if (!scans.has(repo)) scans.set(repo, scanRepo(path, { ...ctx, fetch: true }));
    const scanned = scans.get(repo) as RepoScan;
    if (scanned.fetchFailed) return { id, done: false, message: 'refused: git fetch failed, so the refs may be stale' };
    const item = scanned.items.find((i) => i.id === id);
    if (!item && scanned.review.some((i) => i.id === id)) return { id, done: false, message: 'refused: patch-equivalent only (no merged PR or ancestry); needs a human look' };
    if (!item) {
      const ex = scanned.excluded.find((i) => i.id === id);
      return { id, done: false, message: `refused: no longer qualifies${ex ? ` (${ex.reason})` : ' (or its tip moved since it was listed)'}` };
    }
    if (item.kind === 'remote-branch') return deleteRemoteBranch(path, item, id);
    return removeWorktree(path, item, id, ctx.disposableIgnored);
  });
}

/**
 * Removes one worktree the scan listed, never with --force. Right before the removal it re-reads the worktree itself, so
 * what the scan saw cannot have gone stale: HEAD must still be the scanned commit, nothing may be modified, untracked or ignored-but-worth-keeping,
 * and a detached HEAD must still be on origin (once removed, its commits would survive only in the reflog).
 */
export function removeWorktree(path: string, item: { id: string; name: string; kind: string; head?: string; detached?: boolean }, id: string = item.id, disposableIgnored: string[] = SWEEP_DISPOSABLE_IGNORED): ApplyResult {
  const wg = gitIn(item.name);
  const refuse = (m: string): ApplyResult => ({ id, done: false, message: `refused: ${item.name} ${m}` });
  const head = wg('rev-parse', 'HEAD');
  if (!head.ok || head.out !== item.head) return refuse('moved since it was scanned');
  // --untracked-files=all overrides a repo's status.showUntrackedFiles=no, which `git worktree remove` would otherwise honour too.
  const status = wg('status', '--porcelain', '--untracked-files=all', '--ignored=matching');
  if (!status.ok) return refuse(`status unreadable (${status.err})`);
  const disposable = new Set(disposableIgnored);
  const lines = status.out.split('\n').filter(Boolean);
  if (lines.some((l) => l.startsWith('!!') && isEnvFile(l.slice(3)))) return refuse('holds an environment file (may be the only copy)');
  const keeps = lines.filter((l) => !l.startsWith('!!') || !l.slice(3).split('/').some((seg) => disposable.has(seg)));
  if (keeps.length) return refuse('has uncommitted, untracked or non-disposable ignored files');
  if (item.detached && unpushedCount(wg, 'HEAD') !== 0) return refuse('is detached and not on origin');
  const r = run('git', ['-C', path, 'worktree', 'remove', item.name]);
  return { id, done: r.ok, message: r.ok ? `deleted ${item.kind} ${item.name}` : `failed: ${r.err}` };
}

/** `git worktree prune` for the entries whose directory is missing (locked ones stay); returns the paths dropped. Dry runs only list them. */
function pruneMissing(path: string, dryRun: boolean): string[] {
  const gone = worktrees(gitIn(path)).filter((w) => w.prunable && !w.locked)
    .map((w) => w.path);
  if (!gone.length || dryRun) return gone;
  const r = run('git', ['-C', path, 'worktree', 'prune']);
  if (!r.ok) throw new SweepError(`git worktree prune failed: ${r.err}`);
  const left = new Set(worktrees(gitIn(path)).map((w) => w.path));
  return gone.filter((p) => !left.has(p));
}

/** True when the repo has a linked worktree (the main one does not count). A repo git cannot list is not skipped: the scan reports why. */
function hasLinkedWorktree(path: string): boolean {
  try { return worktrees(gitIn(path)).length > 0; } catch { return true; }
}

/**
 * The worktree half of the sweep, applied: prunes entries whose directory is missing, then re-scans each repo that has a linked worktree (worktrees
 * only, after a fetch; a repo with none costs no fetch) and removes every worktree that qualifies. Never forced, never a branch. Returns
 * { removed: [{ repo, path, why }], pruned: [{ repo, path }], kept: [{ repo, path, reason }], notes }, where kept is every
 * worktree left in place with its reason, so uncommitted, untracked and unpushed work is listed rather than touched.
 * With `dryRun` it only reports what it would do. With `budgetSeconds`, a repo that would start after that many seconds is
 * not touched and is listed in `skipped` (the check is at repo boundaries, so one repo may run past the budget).
 */
export function sweepWorktrees(container: string, ctx: SweepContext, { only, dryRun = false, budgetSeconds = 0, clock = Date.now }: { only?: string | null; dryRun?: boolean; budgetSeconds?: number; clock?: () => number } = {}): WorktreeSweep {
  const out: WorktreeSweep = { removed: [], pruned: [], kept: [], notes: [], skipped: [] };
  const started = clock();
  for (const path of findRepos(container, only)) {
    const repo = basename(path);
    if (budgetSeconds > 0 && clock() - started > budgetSeconds * 1000) { out.skipped.push(repo); continue; }
    try { out.pruned.push(...pruneMissing(path, dryRun).map((p) => ({ repo, path: p }))); } catch (e) { out.notes.push(`${repo}: prune skipped: ${errorOf(e).message}`); }
    if (!hasLinkedWorktree(path)) continue; // nothing to remove here: no fetch, no scan
    const scan = scanRepo(path, { ...ctx, fetch: true, worktreesOnly: true });
    out.notes.push(...scan.notes.map((n) => `${repo}: ${n}`));
    const keep = (i: { name: string }, reason: string): void => { out.kept.push({ repo, path: i.name, reason }); };
    const dropped = new Set(out.pruned.filter((x) => x.repo === repo).map((x) => x.path)); // a dry run still sees these
    scan.excluded.filter((e) => !dropped.has(e.name)).forEach((e) => keep(e, e.reason));
    scan.review.forEach((r) => keep(r, 'patch-equivalent only (no merged PR or ancestry); needs a human look'));
    for (const item of scan.items) {
      if (scan.fetchFailed) { keep(item, 'git fetch failed, so the refs may be stale'); continue; }
      if (dryRun) { out.removed.push({ repo, path: item.name, why: item.why }); continue; }
      const r = removeWorktree(path, item, item.id, ctx.disposableIgnored);
      if (r.done) out.removed.push({ repo, path: item.name, why: item.why });
      else keep(item, r.message.replace(`refused: ${item.name} `, 'refused: '));
    }
  }
  return out;
}

/** Reason text to a short label, first match wins; work that is in use (claimed, dirty, a live skill) is named before the branch's merge state. */
const REASON_LABELS: [RegExp, string][] = [
  [/locked/, 'locked'], [/claimed by/, 'repo claimed'], [/live skill/, 'live skill'], [/uncommitted changes/, 'uncommitted changes'],
  [/untracked files/, 'untracked files'], [/environment files/, 'environment files'], [/ignored files kept/, 'non-disposable ignored files'], [/modified \d+ min ago/, 'not idle yet'],
  [/not yours/, 'branch not yours'], [/unpushed|not on any origin ref|not pushed or merged|could not count/, 'unpushed or unverifiable commits'],
  [/not merged/, 'branch not merged'], [/patch-equivalent/, 'needs a human look'], [/fetch failed/, 'fetch failed'], [/^refused/, 'refused at removal'],
];
const reasonLabel = (reason: string): string => REASON_LABELS.find(([re]) => re.test(reason))?.[1] || 'other';

/** Kept worktrees as `label: count` lines, biggest first. */
function keptCounts(kept: { reason: string }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const k of kept) { const l = reasonLabel(k.reason); counts.set(l, (counts.get(l) || 0) + 1); }
  return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([l, n]) => ({ label: l, count: n }));
}
export { keptCounts };

/**
 * Printable lines for a sweepWorktrees result: what went, what stayed, then a count. Kept worktrees print as counts by
 * reason (a big tree keeps hundreds); `verbose` lists each one with its full reason instead.
 */
export function worktreeSweepLines(r: Omit<WorktreeSweep, 'skipped'> & { skipped?: string[] }, dryRun = false, { verbose = false }: { verbose?: boolean } = {}): string[] {
  const verb = dryRun ? 'would remove' : 'removed';
  const kept = verbose
    ? r.kept.map((x) => `${'kept'.padEnd(12)} ${x.path}  (${x.repo}): ${x.reason}`)
    : keptCounts(r.kept).map((c) => `${'kept'.padEnd(12)} ${String(c.count).padStart(3)}  ${c.label}`);
  return [
    ...r.removed.map((x) => `${verb.padEnd(12)} ${x.path}  (${x.repo}; ${x.why})`),
    ...r.pruned.map((x) => `${(dryRun ? 'would prune' : 'pruned').padEnd(12)} ${x.path}  (${x.repo}; directory missing)`),
    ...kept,
    ...r.notes.map((n) => `note         ${n}`),
    ...(r.skipped?.length ? [`sweep budget reached: skipped ${r.skipped.length} repo(s): ${r.skipped.join(', ')}. Re-run with branch-sweep.ts --apply-worktrees --repo <name>.`] : []),
    `worktrees: ${r.removed.length} ${dryRun ? 'to remove' : 'removed'}, ${r.pruned.length} ${dryRun ? 'to prune' : 'pruned'}, ${r.kept.length} kept.${!verbose && r.kept.length ? ' (--verbose lists them)' : ''}`,
  ];
}

function table(rows: ListedItem[]): string {
  const head = ['id', 'repo', 'kind', 'name', 'why', 'prs'];
  const body = rows.map((r) => [r.id, r.repo, r.kind, r.name, r.why, r.prs.join(' ')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(w[i])).join(' | ').trimEnd()).join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const val = (n: string): string | null => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const container = resolve(val('container') || process.cwd());
  const only = val('repo');
  const ctx = defaultContext({ fetch: !argv.includes('--no-fetch'), claimsDir: val('claims-dir') ?? undefined, idleMinutes: val('idle-minutes') ? Number(val('idle-minutes')) : undefined, ...(val('pr-days') ? { prDays: Number(val('pr-days')) } : {}) });
  if (!(ctx.prDays > 0)) ctx.prDays = SWEEP_PR_DAYS;
  if (ctx.idleMinutes === undefined || Number.isNaN(ctx.idleMinutes)) ctx.idleMinutes = SWEEP_IDLE_MINUTES;
  if (!existsSync(container)) { console.error(`branch-sweep: no such container ${container}`); process.exit(2); }

  if (argv.includes('--apply-worktrees')) {
    const r = sweepWorktrees(container, ctx, { only, dryRun: argv.includes('--dry-run'), budgetSeconds: Number(val('budget')) > 0 ? Number(val('budget')) : SWEEP_BUDGET_SECONDS });
    console.log(worktreeSweepLines(r, argv.includes('--dry-run'), { verbose: argv.includes('--verbose') }).join('\n'));
    return;
  }
  if (argv.includes('--apply')) {
    const ids = (val('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { console.error('branch-sweep: --apply needs --ids <repo:hash,...> from a read-only run'); process.exit(2); }
    const results = apply(ids, container, ctx, only);
    for (const r of results) console.log(`${r.done ? 'ok     ' : 'REFUSED'} ${r.id}  ${r.message}`);
    process.exit(results.every((r) => r.done) ? 0 : 1);
  }
  const explain_ = val('explain');
  if (explain_) { for (const p of findRepos(container, only)) console.log(explain(p, ctx, explain_).join('\n')); return; }
  const scans = findRepos(container, only).map((p) => scanRepo(p, ctx));
  const items = scans.flatMap((s) => s.items);
  const review = scans.flatMap((s) => s.review);
  const excluded = scans.flatMap((s) => s.excluded);
  const notes = scans.flatMap((s) => s.notes.map((n) => `${s.repo}: ${n}`));
  if (argv.includes('--json')) { console.log(JSON.stringify({ container, items, review, excluded, notes }, null, 2)); return; }
  console.log(items.length ? table(items) : 'Nothing to sweep.');
  if (review.length) console.log(`\nReview (patch-equivalent only; --apply refuses these):\n${table(review)}`);
  for (const e of excluded) console.log(`kept  ${e.id}  ${e.name}: ${e.reason}`);
  for (const n of notes) console.log(`note  ${n}`);
  console.log(`${items.length} candidates (${items.filter((i) => i.kind === 'worktree').length} worktrees, ${items.filter((i) => i.kind === 'remote-branch').length} remote branches), ${review.length} to review, ${excluded.length} worktrees kept. Nothing was deleted.`);
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
