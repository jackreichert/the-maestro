#!/usr/bin/env node
/**
 * BRANCH SWEEP: lists worktrees and remote branches that can be deleted, for the user to approve in a batch.
 *
 *   node scripts/branch-sweep.mjs [--container <dir>] [--repo <name>] [--json] [--no-fetch] [--pr-days <n>] [--explain <branch>]
 *   node scripts/branch-sweep.mjs --apply --ids <repo:hash,...> [--container <dir>] [--repo <name>]
 *
 * Read-only by default (it runs `git fetch --prune origin` and nothing else that writes). `--apply` deletes only the
 * listed ids, re-scanning each repo first and refusing anything that no longer qualifies. Deleting is
 * `git worktree remove` (never --force) and `git push origin --delete refs/heads/<branch>`; local branches are never deleted.
 *
 * A remote branch qualifies when it is the user's own (it has commits of its own, and every one is by one of git_emails,
 * or by the repo's user.email; no commits means not the user's unless a merged PR names the branch and its tip), is not
 * protected, and is merged into every merge target. A worktree qualifies when its branch does, or its upstream (its own
 * name on origin) was deleted with nothing unpushed, and it is clean, holds no ignored file worth keeping, is not a live
 * skill, is unlocked, not under a live claim and idle. "Merged" is ancestry or a merged PR for this branch (head ref and
 * tip), the twin PR (the other target's PR, from the same branch name with a -staging/-develop suffix added or removed, or
 * linked both ways) counts when the branch's own PR into the other target has exactly its tip and the twin was merged on or after that PR, has only the
 * user's commits, and (if its branch is still on origin) is still at its PR's head. Patch-equivalence alone (`git cherry`, so a squash
 * merge, but also a squash merge that was since reverted) lists the branch under Review, and --apply refuses it.
 * Any git or gh error leaves the item out, with the reason noted.
 * The `gh` binary is `MAESTRO_GH` if set. Settings: local-config.mjs and reference/local-config.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_EMAILS, PROTECTED_BRANCHES, SWEEP_MERGE_TARGETS, SWEEP_IDLE_MINUTES, SWEEP_PR_DAYS, SWEEP_PROTECT_SYMLINK_DIRS, SWEEP_DISPOSABLE_IGNORED, TWIN_FLOW_REPOS, GH_LOGIN, LEDGER_ROOT, VAULT_ROOT, CONTAINER_PROJECT,
} from './local-config.mjs';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
// --no-optional-locks: a scan must not refresh the index, or it would reset the idle clock it reads.
const gitIn = (repo) => Object.assign((...a) => run('git', ['--no-optional-locks', '-C', repo, ...a]), { repo });

/** `gh <args>` as parsed JSON, or null when gh is missing, unauthenticated or fails. The default for ctx.gh. */
export function ghJson(repo, args) {
  const r = run(process.env.MAESTRO_GH || 'gh', args, { cwd: repo });
  try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
}

/** Item id: bound to the branch tip, so an id from one listing cannot delete a branch that has moved on since. */
const idOf = (repo, kind, name, tip) => `${repo}:${createHash('sha1').update(`${repo}\0${kind}\0${name}\0${tip}`).digest('hex').slice(0, 8)}`;

/** Live claims (Claims/<repo>.lock under the ledger root), as Map repo -> claim. Stale ones (dead pid here, or over 12h) do not count. */
export function liveClaims(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const n of readdirSync(dir).filter((f) => f.endsWith('.lock'))) {
    let c; try { c = JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { c = {}; }
    const age = c.time ? (Date.now() - Date.parse(c.time)) / 36e5 : Infinity;
    let dead = false;
    if (c.pid && c.host === hostname()) { try { process.kill(c.pid, 0); } catch (e) { dead = e.code !== 'EPERM'; } }
    if (!dead && age <= 12) out.set(n.slice(0, -5), c);
  }
  return out;
}

export function defaultContext(over = {}) {
  const claimsDir = over.claimsDir ?? process.env.MAESTRO_CLAIMS_DIR ?? ((LEDGER_ROOT || VAULT_ROOT) && join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONTAINER_PROJECT, 'Claims'));
  return {
    emails: GIT_EMAILS, protectedNames: PROTECTED_BRANCHES, twin: TWIN_FLOW_REPOS, targets: SWEEP_MERGE_TARGETS,
    idleMinutes: SWEEP_IDLE_MINUTES, prDays: SWEEP_PR_DAYS, protectDirs: SWEEP_PROTECT_SYMLINK_DIRS, disposableIgnored: SWEEP_DISPOSABLE_IGNORED, claims: liveClaims(claimsDir), gh: ghJson, ghLogin: GH_LOGIN, fetch: true, ...over,
  };
}

/** Merge targets for a repo: explicit entry, else develop + staging in twin-flow repos, else develop. Falls back to the origin default branch for a non-twin repo with no develop. */
function targetsFor(g, name, ctx) {
  const exists = (b) => g('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`).ok;
  const wanted = ctx.targets[name] || (ctx.twin.includes(name) ? ['develop', 'staging'] : ['develop']);
  const missing = wanted.filter((b) => !exists(b));
  if (!missing.length) return { targets: wanted };
  const head = g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');
  if (!ctx.targets[name] && !ctx.twin.includes(name) && head && exists(head)) return { targets: [head] };
  return { error: `merge target ${missing.join(', ')} not on origin` };
}

const rule = (name, check, reason) => ({ name, check, reason });
const firstFailure = (rules, c) => rules.find((r) => !r.check(c));

/** A git or gh call that failed. The item it was judging does not qualify; `kind` says which tool, so gh outages are noted once. */
class SweepError extends Error {
  constructor(message, kind = 'git') { super(message); this.kind = kind; }
}
/** stdout of a git call that must succeed; any failure throws. */
function must(g, ...args) {
  const r = g(...args);
  if (!r.ok) throw new SweepError(`git ${args.slice(0, 2).join(' ')} failed: ${r.err || `exit ${r.status}`}`);
  return r.out;
}
/** `merge-base --is-ancestor`: exit 0 is yes, 1 is no, anything else is an error. */
function isAncestor(g, a, b) {
  const r = g('merge-base', '--is-ancestor', a, b);
  if (r.status !== 0 && r.status !== 1) throw new SweepError(`git merge-base --is-ancestor failed: ${r.err || `exit ${r.status}`}`);
  return r.status === 0;
}

/** Commits on the first-parent line of every protected ref: the mainline, which no branch owns. */
const mainlineOf = (g, protectedRefs) => new Set(protectedRefs.flatMap((p) => must(g, 'rev-list', '--first-parent', p).split('\n').filter(Boolean)));

/**
 * For a protected ref that already contains `ref`: the mainline commit just before the OLDEST first-parent merge on that
 * ref that brought in `ref` (a merge, not itself reachable from `ref`, with a second or later parent that is). That is
 * where the branch forked off as far as that ref is concerned, counted from its first merge, so a commit it contributed in
 * an earlier merge round, or one it picked up from another branch merged before it, is not hidden by a later merge.
 * Null when there is no such merge (a fast-forward), so nothing is subtracted on its account.
 */
function mergedFrom(g, ref, p) {
  const chain = must(g, 'rev-list', '--first-parent', '--parents', '--reverse', `${ref}..${p}`).split('\n').filter(Boolean).map((l) => l.split(' '));
  const merge = chain.find(([, , ...others]) => others.some((o) => isAncestor(g, o, ref)));
  return merge ? merge[1] : null;
}

/**
 * The branch's own non-merge commits as [{ sha, email }]. Reachable from `ref`, not from a protected tip that does
 * not already contain it, not from the mainline just before the first merge into a protected tip that does (so a branch
 * cut from a busy develop does not inherit everyone else's commits), and not on a protected mainline. A squash or rebase
 * merge leaves the branch's commits all here; a --no-ff merge keeps them here too, which is what lets a merged branch
 * be judged by who wrote it.
 */
function ownCommits(g, ref, protectedRefs, mainline) {
  const outside = protectedRefs.filter((p) => !isAncestor(g, ref, p));
  const forks = protectedRefs.filter((p) => !outside.includes(p)).map((p) => mergedFrom(g, ref, p)).filter(Boolean);
  const not = [...outside, ...forks];
  const log = must(g, 'log', '--no-merges', '--format=%H %ae', ref, ...(not.length ? ['--not', ...not] : []));
  return log.split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([sha]) => !mainline.has(sha)).map(([sha, email]) => ({ sha, email }));
}

/** Ownership rules. A branch is the user's only when all pass; no commit of its own is never enough by itself. */
const OWNERSHIP_RULES = [
  rule('emails configured', (c) => c.emails.length > 0, () => 'no author emails (git_emails or user.email)'),
  rule('has commits of its own, or an exact merged PR the user opened', (c) => c.own.length > 0 || c.exactPrs().some((p) => c.ghLogin && p.author?.login === c.ghLogin),
    () => 'no commits of its own and no merged PR with this head opened by the user (gh_login)'),
  rule('every own commit is the user\'s', (c) => c.own.every((x) => c.emails.includes(x.email)),
    (c) => `${c.own.filter((x) => !c.emails.includes(x.email)).length} of ${c.own.length} commits are by someone else`),
];

/** The user's author emails: the configured list, else the repo's own user.email. */
const emailsFor = (g, ctx) => (ctx.emails.length ? ctx.emails : [g('config', 'user.email').out]).filter(Boolean);

function isMine(g, ref, branch, tip, scan) {
  const { ctx } = scan;
  const emails = emailsFor(g, ctx);
  const c = { emails, ghLogin: ctx.ghLogin, own: ownCommits(g, ref, scan.protectedRefs, scan.mainline), exactPrs: () => exactPrs(g.repo, branch, tip, ctx) };
  const failed = firstFailure(OWNERSHIP_RULES, c);
  return failed ? { ok: false, reason: failed.reason(c) } : { ok: true };
}

const PR_FIELDS = 'number,baseRefName,headRefName,headRefOid,url,body,mergedAt,author';
const PR_PAGE = 1000; // gh search returns at most this many per query; a full page means the window may hold more
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Merged PRs whose merge date falls in [from, to] (UTC days). A full page splits the window in two, so nothing is cut off. */
function mergedWindow(repo, ctx, from, to) {
  const prs = ctx.gh(repo, ['pr', 'list', '--state', 'merged', '--search', `merged:${day(from)}..${day(to)}`, '--limit', String(PR_PAGE), '--json', PR_FIELDS]);
  if (!Array.isArray(prs)) throw new SweepError('gh pr list failed: PR evidence unavailable', 'gh');
  if (prs.length < PR_PAGE || day(from) === day(to)) return prs;
  const mid = from + Math.floor((to - from) / 864e5 / 2) * 864e5;
  return [...mergedWindow(repo, ctx, from, mid), ...mergedWindow(repo, ctx, mid + 864e5, to)];
}

/**
 * Merged PRs of a repo merged in the last `ctx.prDays` days (default 180), fetched once per scan in 14-day windows
 * (a plain `gh pr list --limit` is capped and sorted by creation, so it silently drops merged PRs). An older PR just
 * reads as not merged. A failed call throws.
 */
function mergedPrs(repo, ctx) {
  ctx.prCache ??= new Map();
  if (!ctx.prCache.has(repo)) {
    const end = Date.parse(day(Date.now())); const start = end - (ctx.prDays ?? 180) * 864e5;
    const byNumber = new Map();
    for (let from = start; from <= end; from += 14 * 864e5) {
      for (const p of mergedWindow(repo, ctx, from, Math.min(from + 13 * 864e5, end))) byNumber.set(p.number, p);
    }
    ctx.prCache.set(repo, [...byNumber.values()]);
  }
  return ctx.prCache.get(repo);
}

/** Merged PRs whose head ref is `name` and whose head commit is exactly `tip`. */
const exactPrs = (repo, name, tip, ctx) => mergedPrs(repo, ctx).filter((p) => p.headRefName === name && p.headRefOid === tip);

/** A twin branch name differs only by a `-staging` / `-develop` suffix: `x` and `x-staging`, `x` and `x-develop`, `x-develop` and `x-staging`. */
const stem = (b) => b.replace(/-(staging|develop)$/, '');
const prNumbers = (body) => new Set([...(body || '').matchAll(/(?:#|\/pull\/)(\d+)/g)].map((m) => Number(m[1])));

/** Epoch ms of a PR's mergedAt, NaN when absent, so every comparison against it is false. */
const mergedAtMs = (q) => Date.parse(q.mergedAt ?? '');

/** Twin PR rules: `check` gets (c, q, own) for a candidate merged PR `q` into the twin target; all must pass. */
const TWIN_RULES = [
  rule('merged after the branch\'s own PR', (c, q, own) => own.some((p) => mergedAtMs(q) >= mergedAtMs(p)), () => 'merged before the branch\'s own PR'),
  rule('twin head commit is readable', (c, q) => c.g('cat-file', '-e', `${q.headRefOid}^{commit}`).ok, () => 'twin head commit not in this repo'),
  rule('twin branch tip matches the PR', (c, q) => {
    const r = c.g('rev-parse', '--verify', '-q', `refs/remotes/origin/${q.headRefName}`);
    return !r.ok || r.out === q.headRefOid;
  }, () => 'twin branch moved since the PR'),
  rule('every twin commit is the user\'s', (c, q) => {
    const own = ownCommits(c.g, q.headRefOid, c.protectedRefs, c.mainline);
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
function twinPr(c, target) {
  const own = c.exact().filter((p) => p.baseRefName !== target && c.targets.includes(p.baseRefName));
  if (!own.length) return null;
  const linked = (q) => own.some((p) => prNumbers(q.body).has(p.number) && prNumbers(p.body).has(q.number));
  return mergedPrs(c.g.repo, c.ctx)
    .filter((q) => q.baseRefName === target && q.headRefName !== c.name && (stem(q.headRefName) === stem(c.name) || linked(q)))
    .find((q) => TWIN_RULES.every((r) => r.check(c, q, own))) || null;
}

/** Evidence that the branch is merged into one target; the first rule that returns evidence wins. `check` gets (c, target). */
const TARGET_RULES = [
  rule('ancestry', (c, t) => isAncestor(c.g, c.ref, `origin/${t}`) && { how: 'ancestry' }, (ev) => ev.how),
  rule('own merged PR', (c, t) => { const pr = c.exact().find((p) => p.baseRefName === t); return pr && { how: `PR #${pr.number}`, url: pr.url }; }, (ev) => ev.how),
  rule('twin PR', (c, t) => { const pr = twinPr(c, t); return pr && { how: `twin PR #${pr.number} (${pr.headRefName})`, url: pr.url }; }, (ev) => ev.how),
];

/** Every commit has a patch-equivalent in the target. Alone this is weak: a revert of a squash merge still matches. */
function cherryEquivalent(g, target, ref) {
  const lines = must(g, 'cherry', target, ref).split('\n').filter(Boolean);
  return lines.length > 0 && !lines.some((l) => l.startsWith('+'));
}

/**
 * Is `ref` (branch `name`, at `tip`) merged into every target? state 'ok' (every target has ancestry or PR
 * evidence), 'review' (the rest only patch-equivalent), or 'no'. Throws on a failed git or gh call.
 */
function mergedEvidence(g, ref, name, tip, targets, scan) {
  const { ctx } = scan;
  const c = { g, ref, name, tip, ctx, targets, emails: emailsFor(g, ctx), protectedRefs: scan.protectedRefs, mainline: scan.mainline, exact: () => exactPrs(g.repo, name, tip, ctx) };
  const per = []; const weak = []; const missing = [];
  for (const t of targets) {
    let hit = null;
    for (const r of TARGET_RULES) { hit = r.check(c, t); if (hit) break; }
    if (hit) per.push({ target: t, ...hit });
    else if (cherryEquivalent(g, `origin/${t}`, ref)) weak.push(t);
    else missing.push(t);
  }
  return { state: missing.length ? 'no' : weak.length ? 'review' : 'ok', per, weak, missing };
}

const why = (ev) => `merged into ${[...ev.per.map((p) => `${p.target} (${p.how})`), ...ev.weak.map((t) => `${t} (patch-equivalent only)`)].join(' and ')}`;
const links = (ev) => ev.per.filter((p) => p.url).map((p) => p.url);

/** Linked worktrees of a repo: [{ path, branch, locked, prunable }]; the main worktree, bare and detached entries are left out. Throws if git cannot list them. */
function worktrees(g) {
  const blocks = must(g, 'worktree', 'list', '--porcelain').split('\n\n').slice(1);
  return blocks.map((b) => {
    const f = (k) => b.split('\n').find((l) => l === k || l.startsWith(`${k} `));
    return { path: f('worktree')?.slice(9), branch: f('branch')?.replace('branch refs/heads/', ''), locked: !!f('locked'), prunable: !!f('prunable') };
  }).filter((w) => w.path && w.branch);
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** Real targets of the symlinks in the skill dirs: the checkouts live skills are loaded from. Throws if a dir cannot be read. */
function liveSkillTargets(repoPath, ctx) {
  const dirs = [join(homedir(), '.claude', 'skills'), join(dirname(repoPath), '.claude', 'skills'), ...(ctx.protectDirs || []).map(expandHome)];
  return dirs.flatMap((d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
      throw new Error(`cannot read skill dir ${d} (${e.code})`);
    }
    return entries.filter((e) => e.isSymbolicLink()).flatMap((e) => {
      try { return [realpathSync(join(d, e.name))]; } catch { return []; } // a dangling link points at nothing a worktree could be
    });
  });
}

/** Worktree rules, in order: the first that fails keeps the worktree. `check` gets { g, w, repoName, ctx, live, status }. */
const WORKTREE_RULES = [
  rule('not locked', (c) => !c.w.locked, () => 'locked'),
  rule('directory present', (c) => !c.w.prunable && existsSync(c.w.path), () => 'directory missing: run git worktree prune'),
  rule('no live claim', (c) => !c.ctx.claims.get(c.repoName), (c) => `repo claimed by ${c.ctx.claims.get(c.repoName).desk || 'a desk'}`),
  rule('skill dirs readable', (c) => !c.live.error, (c) => c.live.error),
  rule('not a live skill', (c) => !c.live.paths.some((t) => t === c.real || t.startsWith(c.real + sep)), () => 'a skill directory symlinks into it: live skill'),
  rule('status readable', (c) => !c.statusError, (c) => `cannot read status: ${c.statusError}`),
  rule('no uncommitted changes', (c) => c.tracked.length === 0, (c) => `uncommitted changes (${c.tracked.length} files)`),
  rule('no untracked files', (c) => c.untracked.length === 0, (c) => `${c.untracked.length} untracked files`),
  rule('no ignored files worth keeping', (c) => c.keptIgnored.length === 0,
    (c) => `${c.keptIgnored.length} ignored files kept (${c.keptIgnored.slice(0, 3).join(', ')}${c.keptIgnored.length > 3 ? ', ...' : ''}): not disposable`),
  rule('idle', (c) => c.idle >= c.ctx.idleMinutes, (c) => `modified ${Math.round(c.idle)} min ago (idle window ${c.ctx.idleMinutes})`),
];

function worktreeBlocker(g, w, repoName, ctx, live) {
  const wg = existsSync(w.path) ? gitIn(w.path) : null;
  const status = wg ? wg('status', '--porcelain', '--ignored=matching') : { ok: true, out: '' };
  const lines = status.out.split('\n').filter(Boolean);
  const disposable = new Set(ctx.disposableIgnored || []);
  const ignored = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(3));
  const gitDir = wg ? wg('rev-parse', '--absolute-git-dir').out : '';
  const stamps = wg ? [w.path, `${gitDir}/HEAD`, `${gitDir}/index`, `${gitDir}/logs/HEAD`].filter(existsSync).map((p) => statSync(p).mtimeMs) : [];
  const c = {
    g, w, repoName, ctx, live, statusError: status.ok ? '' : status.err || 'git status failed', real: wg ? realpathSync(w.path) : w.path,
    tracked: lines.filter((l) => !l.startsWith('??') && !l.startsWith('!!')), untracked: lines.filter((l) => l.startsWith('??')),
    keptIgnored: ignored.filter((p) => !p.split('/').some((seg) => disposable.has(seg))),
    idle: stamps.length ? (Date.now() - Math.max(...stamps)) / 6e4 : 0, // no timestamps readable: treat as just touched
  };
  const failed = WORKTREE_RULES.find((r) => !r.check(c));
  return failed ? failed.reason(c) : null;
}

/** Branch names compared as git resolves them: a `refs/heads/` or `origin/` prefix does not make `develop` a different branch. */
const bare = (b) => b.replace(/^(refs\/heads\/|refs\/remotes\/|origin\/)+/, '');

const escapeRe = (t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** A branch glob as a RegExp over the whole name: `*` stays inside one path segment, `**` crosses them, anything else is literal. */
export const branchGlob = (glob) => new RegExp(`^${glob.split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*')).join('.*')}$`);

/**
 * What counts as protected in one repo: the configured patterns (globs), the merge targets and the default branch.
 * { isProtected(branch), protectedRefs: the origin refs that match (as `origin/<name>`), refs: every origin ref }.
 * Throws if git cannot list the refs.
 */
function protection(g, ctx, targets) {
  const head = g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');
  const matchers = [...ctx.protectedNames, ...targets, head].filter(Boolean).map(branchGlob);
  const isProtected = (b) => matchers.some((re) => re.test(b) || re.test(bare(b)));
  const refs = must(g, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n').filter(Boolean);
  const names = refs.map((f) => f.slice('refs/remotes/origin/'.length)).filter((b) => b !== 'HEAD');
  return { isProtected, refs, protectedRefs: names.filter(isProtected).map((b) => `origin/${b}`) };
}

/** One branch judged: { tip, mine, reason, ev, error }. Evidence is only sought for a branch that is the user's. */
function assess(g, ref, branch, targets, scan) {
  const a = { tip: null, mine: false, reason: '', ev: null, error: null };
  try {
    a.tip = must(g, 'rev-parse', ref);
    const own = isMine(g, ref, branch, a.tip, scan);
    a.mine = own.ok; a.reason = own.reason || '';
  } catch (e) { a.error = e; return a; }
  if (!a.mine) return a;
  try { a.ev = mergedEvidence(g, ref, branch, a.tip, targets, scan); } catch (e) { a.error = e; }
  return a;
}

/** Records why an item was skipped: a git error names the item, a gh outage is noted once per repo. */
function noteError(res, e, label) {
  const msg = e.kind === 'gh' ? `${e.message}; branches needing it were skipped` : `${label} skipped: ${e.message}`;
  if (!res.notes.includes(msg)) res.notes.push(msg);
}

/** Scans one repo: { repo, items: qualifying, review: cherry-only, excluded: worktrees that fail a check, notes }. */
export function scanRepo(repoPath, ctx) {
  const name = basename(repoPath);
  const g = (ctx.gitFor || gitIn)(repoPath);
  const res = { repo: name, items: [], review: [], excluded: [], notes: [] };
  if (!g('remote', 'get-url', 'origin').ok) { res.notes.push('no origin remote'); return res; }
  if (ctx.fetch && !g('fetch', '--prune', 'origin').ok) { res.notes.push('git fetch failed; using the refs already here'); res.fetchFailed = true; }
  const { targets, error } = targetsFor(g, name, ctx);
  if (error) { res.notes.push(error); return res; }
  let live; try { live = { paths: liveSkillTargets(repoPath, ctx) }; } catch (e) { live = { paths: [], error: e.message }; }
  let scan; let refs; let wts; let isProtected;
  try {
    const prot = protection(g, ctx, targets);
    ({ isProtected, refs } = prot);
    scan = { ctx, protectedRefs: prot.protectedRefs, mainline: mainlineOf(g, prot.protectedRefs) };
    wts = worktrees(g);
  } catch (e) { res.notes.push(`scan stopped: ${e.message}`); return res; }

  for (const full of refs) {
    const branch = full.slice('refs/remotes/origin/'.length);
    if (full === 'refs/remotes/origin/HEAD' || isProtected(branch)) continue;
    const a = assess(g, full, branch, targets, scan);
    if (a.error) { noteError(res, a.error, `branch ${branch}`); continue; }
    if (!a.ev || a.ev.state === 'no') continue;
    (a.ev.state === 'ok' ? res.items : res.review).push({ id: idOf(name, 'remote-branch', branch, a.tip), repo: name, kind: 'remote-branch', name: branch, why: why(a.ev), prs: links(a.ev) });
  }
  for (const w of wts) {
    if (isProtected(w.branch)) continue;
    scanWorktree({ g, w, name, targets, scan, live, res });
  }
  return res;
}

/** One linked worktree: qualifies on its branch (or a deleted upstream with nothing unpushed), then must pass every worktree rule. */
function scanWorktree({ g, w, name, targets, scan, live, res }) {
  const ref = `refs/heads/${w.branch}`;
  const a = assess(g, ref, w.branch, targets, scan);
  const base = { id: idOf(name, 'worktree', w.path, a.tip || 'unknown'), repo: name, kind: 'worktree', name: w.path };
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
    if (reason || state !== 'review') return;
  }
  const blocker = worktreeBlocker(g, w, name, scan.ctx, live);
  if (blocker) { res.excluded.push({ ...base, reason: blocker }); return; }
  if (state === 'ok') res.items.push({ ...base, why: `branch ${w.branch}: ${why(a.ev)}`, prs: links(a.ev) });
  else if (goneClean) res.items.push({ ...base, why: `branch ${w.branch} deleted on origin, nothing unpushed`, prs: [] });
  else if (state === 'review') res.review.push({ ...base, why: `branch ${w.branch}: ${why(a.ev)}`, prs: links(a.ev) });
}

/** Runs a rule list's checks one by one and prints each verdict; a thrown git or gh error prints as the verdict. */
const verdict = (label, r, ...args) => {
  try { const v = r.check(...args); return `  ${v ? 'PASS' : 'FAIL'} ${label}${v && v.how ? `: ${v.how}` : ''}${!v && r.reason && args.length === 1 ? ` (${r.reason(...args)})` : ''}`; } catch (e) { return `  ERROR ${label}: ${e.message}`; }
};

/** Per-rule verdicts for one remote branch, for --explain: ownership, then every target rule, then the overall result. Read-only. */
export function explain(repoPath, ctx, branch) {
  const g = (ctx.gitFor || gitIn)(repoPath);
  const out = [`${basename(repoPath)} ${branch}`];
  if (ctx.fetch && !g('fetch', '--prune', 'origin').ok) out.push('  note: git fetch failed; using the refs already here');
  const ref = `refs/remotes/origin/${branch}`;
  if (!g('rev-parse', '--verify', '-q', ref).ok) return [...out, '  not on origin'];
  const { targets, error } = targetsFor(g, basename(repoPath), ctx);
  if (error) return [...out, `  ${error}`];
  let prot;
  try { prot = protection(g, ctx, targets); } catch (e) { return [...out, `  ERROR ${e.message}`]; }
  const { protectedRefs } = prot;
  if (prot.isProtected(branch)) return [...out, '  FAIL protected branch'];
  try {
    const tip = must(g, 'rev-parse', ref);
    const emails = emailsFor(g, ctx);
    const mainline = mainlineOf(g, protectedRefs);
    const own = ownCommits(g, ref, protectedRefs, mainline);
    const c = { emails, ghLogin: ctx.ghLogin, own, exactPrs: () => exactPrs(g.repo, branch, tip, ctx) };
    out.push(`  tip ${tip.slice(0, 9)}, ${own.length} own commits, targets ${targets.join('+')}, PR look-back ${ctx.prDays ?? 180} days, ${mergedPrs(g.repo, ctx).length} merged PRs read`);
    out.push(`  exact PRs (head ${branch} at tip): ${c.exactPrs().map((p) => `#${p.number}->${p.baseRefName}`).join(', ') || 'none'}`);
    out.push('ownership:', ...OWNERSHIP_RULES.map((r) => verdict(r.name, r, c)));
    const tc = { g, ref, name: branch, tip, ctx, targets, emails, protectedRefs, mainline, exact: c.exactPrs };
    for (const t of targets) {
      out.push(`target ${t}:`, ...TARGET_RULES.map((r) => verdict(r.name, r, tc, t)));
      try { out.push(`  ${cherryEquivalent(g, `origin/${t}`, ref) ? 'PASS' : 'FAIL'} patch-equivalent (review only)`); } catch (e) { out.push(`  ERROR cherry: ${e.message}`); }
    }
    const a = assess(g, ref, branch, targets, { ctx, protectedRefs, mainline });
    out.push(`result: ${a.error ? `skipped (${a.error.message})` : !a.mine ? `not mine (${a.reason})` : a.ev.state === 'ok' ? `CANDIDATE, ${why(a.ev)}` : a.ev.state === 'review' ? 'REVIEW' : `not merged into ${a.ev.missing.join(', ')}`}`);
  } catch (e) { out.push(`  ERROR ${e.message}`); }
  return out;
}

/** Git repos directly under the container (linked worktrees, whose .git is a file, are reached through their main repo). */
export function findRepos(container, only) {
  return readdirSync(container, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && (!only || d.name === only))
    .map((d) => join(container, d.name)).filter((p) => statSync(join(p, '.git'), { throwIfNoEntry: false })?.isDirectory());
}

/** Deletes the listed ids after re-scanning; returns [{ id, done, message }]. Anything no longer qualifying is refused. */
export function apply(ids, container, ctx, only) {
  const scans = new Map();
  return ids.map((id) => {
    const repo = id.slice(0, id.lastIndexOf(':'));
    if (only && repo !== only) return { id, done: false, message: `not in --repo ${only}` };
    const path = join(container, repo);
    if (!findRepos(container, repo).length) return { id, done: false, message: `no repo ${repo} in the container` };
    if (!scans.has(repo)) scans.set(repo, scanRepo(path, { ...ctx, fetch: true }));
    if (scans.get(repo).fetchFailed) return { id, done: false, message: 'refused: git fetch failed, so the refs may be stale' };
    const item = scans.get(repo).items.find((i) => i.id === id);
    if (!item && scans.get(repo).review.some((i) => i.id === id)) return { id, done: false, message: 'refused: patch-equivalent only (no merged PR or ancestry); needs a human look' };
    if (!item) {
      const ex = scans.get(repo).excluded.find((i) => i.id === id);
      return { id, done: false, message: `refused: no longer qualifies${ex ? ` (${ex.reason})` : ' (or its tip moved since it was listed)'}` };
    }
    const r = item.kind === 'worktree' ? run('git', ['-C', path, 'worktree', 'remove', item.name]) : run('git', ['-C', path, 'push', 'origin', '--delete', `refs/heads/${item.name}`]);
    return { id, done: r.ok, message: r.ok ? `deleted ${item.kind} ${item.name}` : `failed: ${r.err}` };
  });
}

function table(rows) {
  const head = ['id', 'repo', 'kind', 'name', 'why', 'prs'];
  const body = rows.map((r) => [r.id, r.repo, r.kind, r.name, r.why, r.prs.join(' ')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(w[i])).join(' | ').trimEnd()).join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const container = resolve(val('container') || process.cwd());
  const only = val('repo');
  const ctx = defaultContext({ fetch: !argv.includes('--no-fetch'), claimsDir: val('claims-dir') ?? undefined, idleMinutes: val('idle-minutes') ? Number(val('idle-minutes')) : undefined, ...(val('pr-days') ? { prDays: Number(val('pr-days')) } : {}) });
  if (!(ctx.prDays > 0)) ctx.prDays = SWEEP_PR_DAYS;
  if (ctx.idleMinutes === undefined || Number.isNaN(ctx.idleMinutes)) ctx.idleMinutes = SWEEP_IDLE_MINUTES;
  if (!existsSync(container)) { console.error(`branch-sweep: no such container ${container}`); process.exit(2); }

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
