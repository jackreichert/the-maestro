/**
 * A read-only checkout of someone else's PR, for the helper to read and run tests in. It never touches their branch:
 * the PR head is fetched by its `refs/pull/<n>/head` ref and checked out DETACHED into a worktree of its own under `<worktrees dir>`, so there is no
 * branch to commit to, and the files are then made unwritable (the `.git` link stays writable, git needs it). Nothing here pushes, and no remote is written.
 * `prepare` refuses a PR that is the user's own, is a draft or is not open, a repo that is self-review, and a repo with no local clone.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isSelfReview } from '../self-review.ts';

export interface Cmd { status: number | null; stdout: string; stderr: string }
/** Runs `cmd` (gh or git) with args in `cwd`. Tests pass a stub or a real runner against a temp repo. */
export type Runner = (cmd: 'gh' | 'git', args: string[], cwd?: string) => Cmd;

export interface PrepareOptions { repo: string; pr: number; self: string; selfRepos: readonly string[]; containerRoot: string; worktreesDir: string; run: Runner }
export interface Prepared { path: string; head: string; base: string; repo: string; pr: number; diff: string }

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const first = (s: string): string => s.split('\n')[0]?.slice(0, 200) ?? '';

/** Walks the tree and drops write permission; symlinks are left alone, and `.git` (the link file) and `node_modules` (an install's output) are skipped. */
export function lock(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) lock(p);
    else chmodSync(p, st.mode & 0o555);
  }
  chmodSync(dir, lstatSync(dir).mode & 0o555);
}

/** Lets git delete a locked worktree again. */
export function unlock(dir: string): void {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) unlock(p); else chmodSync(p, st.mode | 0o200);
  }
}

export function prepare(o: PrepareOptions): Prepared {
  const m = REPO.exec(o.repo);
  if (!m || !Number.isSafeInteger(o.pr) || o.pr <= 0) throw new Error('bad repo or PR number');
  if (isSelfReview(o.repo, o.selfRepos)) throw new Error(`${o.repo} is a self-review repo: the helper only covers repos other people review`);
  const view = o.run('gh', ['pr', 'view', String(o.pr), '--repo', o.repo, '--json', 'author,isDraft,state,headRefOid,baseRefName']);
  if (view.status !== 0) throw new Error(`gh pr view failed: ${first(view.stderr)}`);
  const info = JSON.parse(view.stdout) as { author?: { login?: string }; isDraft?: boolean; state?: string; headRefOid?: string; baseRefName?: string };
  if ((info.author?.login ?? '').toLowerCase() === o.self.toLowerCase()) throw new Error('that PR is your own: the helper never reviews it');
  if (info.state !== 'OPEN' || info.isDraft) throw new Error('that PR is not open and ready for review');
  const head = info.headRefOid ?? '';
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('could not read the PR head');
  const base = info.baseRefName ?? '';
  if (!/^[A-Za-z0-9._\/-]+$/.test(base) || base.startsWith('-')) throw new Error('could not read the PR base');
  const repoDir = join(resolve(o.containerRoot), m[2] as string);
  if (!existsSync(join(repoDir, '.git'))) throw new Error(`no local clone of ${o.repo} under the container folder`);
  const path = join(resolve(o.worktreesDir), `review-${m[2]}-${o.pr}-${head.slice(0, 7)}`);
  const fetched = o.run('git', ['fetch', '--quiet', 'origin', `refs/pull/${o.pr}/head`, base], repoDir);
  if (fetched.status !== 0) throw new Error(`git fetch failed: ${first(fetched.stderr)}`);
  if (!existsSync(path)) {
    mkdirSync(resolve(o.worktreesDir), { recursive: true });
    const added = o.run('git', ['worktree', 'add', '--detach', path, head], repoDir);
    if (added.status !== 0) throw new Error(`git worktree add failed: ${first(added.stderr)}`);
    lock(path);
  }
  return { path, head, base, repo: o.repo, pr: o.pr, diff: `git -C ${path} diff origin/${base}...${head}` };
}

/** Removes a prepared worktree. Only a path directly under `worktreesDir` named `review-*` is ever removed. */
export function cleanup(o: { repo: string; path: string; worktreesDir: string; containerRoot: string; run: Runner }): void {
  const m = REPO.exec(o.repo);
  if (!m) throw new Error('bad repo');
  const path = resolve(o.path);
  const root = resolve(o.worktreesDir);
  if (resolve(path, '..') !== root || !/^review-[A-Za-z0-9_.-]+$/.test(path.slice(root.length + 1))) throw new Error('not a review worktree');
  if (!existsSync(path)) return;
  unlock(path);
  const r = o.run('git', ['worktree', 'remove', '--force', path], join(resolve(o.containerRoot), m[2] as string));
  if (r.status !== 0) throw new Error(`git worktree remove failed: ${first(r.stderr)}`);
}
