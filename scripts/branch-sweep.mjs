#!/usr/bin/env node
/**
 * BRANCH SWEEP: lists worktrees and remote branches that can be deleted, for the user to approve in a batch.
 *
 *   node scripts/branch-sweep.mjs [--container <dir>] [--repo <name>] [--json] [--no-fetch]
 *   node scripts/branch-sweep.mjs --apply --ids <repo:hash,...> [--container <dir>] [--repo <name>]
 *
 * Read-only by default (it runs `git fetch --prune origin` and nothing else that writes). `--apply` deletes only the
 * listed ids, re-scanning each repo first and refusing anything that no longer qualifies. Deleting is
 * `git worktree remove` (never --force) and `git push origin --delete <branch>`; local branches are never deleted.
 *
 * A remote branch qualifies when it is the user's own (every non-merge commit not already on a protected branch is
 * by one of git_emails, or by the repo's user.email), not protected, and merged into every merge target. A worktree
 * qualifies when its branch does, or its upstream was deleted with nothing unpushed, and it is clean, unlocked,
 * not under a live claim and idle. "Merged" is ancestry, patch-equivalence (`git cherry`, so squash merges count)
 * or a merged PR whose head is exactly the branch tip (gh), twin PR found by the link in the PR body.
 * The `gh` binary is `MAESTRO_GH` if set. Settings: local-config.mjs and reference/local-config.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_EMAILS, PROTECTED_BRANCHES, SWEEP_MERGE_TARGETS, SWEEP_IDLE_MINUTES, TWIN_FLOW_REPOS, LEDGER_ROOT, VAULT_ROOT, CONTAINER_PROJECT,
} from './local-config.mjs';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const gitIn = (repo) => Object.assign((...a) => run('git', ['-C', repo, ...a]), { repo });

/** `gh <args>` as parsed JSON, or null when gh is missing, unauthenticated or fails. The default for ctx.gh. */
export function ghJson(repo, args) {
  const r = run(process.env.MAESTRO_GH || 'gh', args, { cwd: repo });
  try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; }
}

const idOf = (repo, kind, name) => `${repo}:${createHash('sha1').update(`${repo}\0${kind}\0${name}`).digest('hex').slice(0, 8)}`;

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
    idleMinutes: SWEEP_IDLE_MINUTES, claims: liveClaims(claimsDir), gh: ghJson, fetch: true, ...over,
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

/** Who wrote the branch: authors of non-merge commits not on any protected ref; for a fully merged branch, its newest non-merge commit. */
function isMine(g, ref, protectedRefs, ctx) {
  const emails = ctx.emails.length ? ctx.emails : [g('config', 'user.email').out];
  let authors = g('log', '--no-merges', '--format=%ae', ref, '--not', ...protectedRefs).out.split('\n').filter(Boolean);
  if (!authors.length) authors = g('log', '-1', '--no-merges', '--format=%ae', ref).out.split('\n').filter(Boolean);
  return authors.length > 0 && authors.every((a) => emails.includes(a));
}

/** Is `ref` (branch `name`) merged into every target? { ok, per: [{ target, how, url? }], missing }. */
function mergedEvidence(g, ref, name, targets, ctx) {
  const tip = g('rev-parse', ref).out;
  const per = []; const missing = [];
  for (const t of targets) {
    const tr = `origin/${t}`;
    if (g('merge-base', '--is-ancestor', ref, tr).ok) per.push({ target: t, how: 'ancestry' });
    else if (!g('cherry', tr, ref).out.split('\n').some((l) => l.startsWith('+'))) per.push({ target: t, how: 'cherry' });
    else missing.push(t);
  }
  if (missing.length) {
    const own = (ctx.gh(g.repo, ['pr', 'list', '--head', name, '--state', 'merged', '--limit', '30', '--json', 'number,baseRefName,mergedAt,headRefOid,url,body']) || [])
      .filter((p) => p.headRefOid === tip);
    for (const t of [...missing]) {
      let pr = own.find((p) => p.baseRefName === t);
      if (!pr && own.length) { // twin by link: the other target's PR is named in a body, merged, into that target
        for (const n of new Set(own.flatMap((p) => [...(p.body || '').matchAll(/(?:#|\/pull\/)(\d+)/g)].map((m) => m[1])))) {
          const v = ctx.gh(g.repo, ['pr', 'view', n, '--json', 'number,state,baseRefName,url']);
          if (v?.state === 'MERGED' && v.baseRefName === t) { pr = v; break; }
        }
      }
      if (pr) { per.push({ target: t, how: `PR #${pr.number}`, url: pr.url }); missing.splice(missing.indexOf(t), 1); }
    }
  }
  return { ok: !missing.length, per, missing };
}

const why = (ev) => `merged into ${ev.per.map((p) => `${p.target} (${p.how})`).join(' and ')}`;
const links = (ev) => ev.per.filter((p) => p.url).map((p) => p.url);

/** Linked worktrees of a repo: [{ path, branch, locked, prunable }]; the main worktree, bare and detached entries are left out. */
function worktrees(g) {
  const blocks = g('worktree', 'list', '--porcelain').out.split('\n\n').slice(1);
  return blocks.map((b) => {
    const f = (k) => b.split('\n').find((l) => l === k || l.startsWith(`${k} `));
    return { path: f('worktree')?.slice(9), branch: f('branch')?.replace('branch refs/heads/', ''), locked: !!f('locked'), prunable: !!f('prunable') };
  }).filter((w) => w.path && w.branch);
}

function worktreeBlocker(g, w, repoName, ctx) {
  if (w.locked) return 'locked';
  if (w.prunable || !existsSync(w.path)) return 'directory missing: run git worktree prune';
  const claim = ctx.claims.get(repoName);
  if (claim) return `repo claimed by ${claim.desk || 'a desk'}`;
  const st = gitIn(w.path)('status', '--porcelain').out.split('\n').filter(Boolean);
  const untracked = st.filter((l) => l.startsWith('??')).length;
  if (st.length - untracked) return `uncommitted changes (${st.length - untracked} files)`;
  if (untracked) return `${untracked} untracked files`;
  const gitDir = gitIn(w.path)('rev-parse', '--absolute-git-dir').out;
  const newest = Math.max(...[w.path, `${gitDir}/HEAD`, `${gitDir}/index`, `${gitDir}/logs/HEAD`].filter(existsSync).map((p) => statSync(p).mtimeMs));
  const idle = (Date.now() - newest) / 6e4;
  return idle < ctx.idleMinutes ? `modified ${Math.round(idle)} min ago (idle window ${ctx.idleMinutes})` : null;
}

/** Scans one repo: { repo, items: qualifying, excluded: worktrees that fail a worktree check, notes }. */
export function scanRepo(repoPath, ctx) {
  const name = basename(repoPath);
  const g = gitIn(repoPath);
  const res = { repo: name, items: [], excluded: [], notes: [] };
  if (!g('remote', 'get-url', 'origin').ok) { res.notes.push('no origin remote'); return res; }
  if (ctx.fetch && !g('fetch', '--prune', 'origin').ok) res.notes.push('git fetch failed; using the refs already here');
  const { targets, error } = targetsFor(g, name, ctx);
  if (error) { res.notes.push(error); return res; }
  const head = g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').out.replace(/^origin\//, '');
  const protectedNames = new Set([...ctx.protectedNames, ...targets, head].filter(Boolean));
  const protectedRefs = [...protectedNames].filter((b) => g('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`).ok).map((b) => `origin/${b}`);

  const evaluate = (ref, branch) => (isMine(g, ref, protectedRefs, ctx) ? mergedEvidence(g, ref, branch, targets, ctx) : null);
  for (const line of g('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').out.split('\n')) {
    const branch = line.replace(/^origin\/?/, '');
    if (!branch || branch === 'HEAD' || protectedNames.has(branch)) continue;
    const ev = evaluate(line, branch);
    if (ev?.ok) res.items.push({ id: idOf(name, 'remote-branch', branch), repo: name, kind: 'remote-branch', name: branch, why: why(ev), prs: links(ev) });
  }
  for (const w of worktrees(g)) {
    if (protectedNames.has(w.branch)) continue;
    const ref = `refs/heads/${w.branch}`;
    const gone = g('config', `branch.${w.branch}.remote`).ok && !g('rev-parse', '--verify', '-q', `refs/remotes/origin/${w.branch}`).ok;
    const ev = evaluate(ref, w.branch);
    const ahead = Number(g('rev-list', '--count', ref, '--not', '--remotes').out) || 0;
    const base = { id: idOf(name, 'worktree', w.path), repo: name, kind: 'worktree', name: w.path };
    if (!ev?.ok && !(gone && ahead === 0)) {
      if (gone) res.excluded.push({ ...base, reason: `branch ${w.branch} is gone from origin but ${ahead} commit(s) are not pushed or merged` });
      continue;
    }
    const blocker = worktreeBlocker(g, w, name, ctx);
    if (blocker) res.excluded.push({ ...base, reason: blocker });
    else res.items.push({ ...base, why: ev?.ok ? `branch ${w.branch}: ${why(ev)}` : `branch ${w.branch} deleted on origin, nothing unpushed`, prs: ev?.ok ? links(ev) : [] });
  }
  return res;
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
    const item = scans.get(repo).items.find((i) => i.id === id);
    if (!item) {
      const ex = scans.get(repo).excluded.find((i) => i.id === id);
      return { id, done: false, message: `refused: no longer qualifies${ex ? ` (${ex.reason})` : ''}` };
    }
    const r = item.kind === 'worktree' ? run('git', ['-C', path, 'worktree', 'remove', item.name]) : run('git', ['-C', path, 'push', 'origin', '--delete', item.name]);
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
  const ctx = defaultContext({ fetch: !argv.includes('--no-fetch'), claimsDir: val('claims-dir') ?? undefined, idleMinutes: val('idle-minutes') ? Number(val('idle-minutes')) : undefined });
  if (ctx.idleMinutes === undefined || Number.isNaN(ctx.idleMinutes)) ctx.idleMinutes = SWEEP_IDLE_MINUTES;
  if (!existsSync(container)) { console.error(`branch-sweep: no such container ${container}`); process.exit(2); }

  if (argv.includes('--apply')) {
    const ids = (val('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { console.error('branch-sweep: --apply needs --ids <repo:hash,...> from a read-only run'); process.exit(2); }
    const results = apply(ids, container, ctx, only);
    for (const r of results) console.log(`${r.done ? 'ok     ' : 'REFUSED'} ${r.id}  ${r.message}`);
    process.exit(results.every((r) => r.done) ? 0 : 1);
  }
  const scans = findRepos(container, only).map((p) => scanRepo(p, ctx));
  const items = scans.flatMap((s) => s.items);
  const excluded = scans.flatMap((s) => s.excluded);
  const notes = scans.flatMap((s) => s.notes.map((n) => `${s.repo}: ${n}`));
  if (argv.includes('--json')) { console.log(JSON.stringify({ container, items, excluded, notes }, null, 2)); return; }
  console.log(items.length ? table(items) : 'Nothing to sweep.');
  for (const e of excluded) console.log(`kept  ${e.id}  ${e.name}: ${e.reason}`);
  for (const n of notes) console.log(`note  ${n}`);
  console.log(`${items.length} candidates (${items.filter((i) => i.kind === 'worktree').length} worktrees, ${items.filter((i) => i.kind === 'remote-branch').length} remote branches), ${excluded.length} worktrees kept. Nothing was deleted.`);
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
