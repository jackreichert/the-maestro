/**
 * The local review queue behind `GET /api/local-review`: branches in the container's repos that hold commits no origin ref has
 * and have no remote branch of the same name. A PR needs a pushed branch, so these are the finished-but-unpushed units waiting
 * for a local re-review before they go up. Read-only and offline: git only, never `gh`, never a fetch, never a write.
 * Each unit carries the re-review verdict recorded for its exact head commit (review-verdict.ts, id `local:<repo>#<branch>`);
 * a verdict recorded for an earlier head is shown as stale, never as a pass. Paths are relative to the container, never absolute.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadVerdicts, localUnitId } from '../../review-verdict.ts';
import type { VerdictRow } from '../../review-verdict.ts';

export type VerdictState = 'ship-it' | 'needs-work' | 'stale' | 'none';
export interface LocalUnit {
  id: string; repo: string; branch: string; head: string; ahead: number; at: string; subject: string;
  /** Container-relative folder of the branch's worktree; the repo's folder when it is not checked out, or its worktree sits outside the container. */
  where: string; checkedOut: boolean;
  /** The base the diff is against, and the command that opens it in the difftool. */
  base: string; command: string;
  verdict: { state: VerdictState; at?: string };
}
export interface LocalReview {
  generatedAt: string;
  /** False when there is nothing to read (no container configured); `reason` then says why, so "none" never stands in for "unknown". */
  available: boolean; reason?: string;
  units: LocalUnit[]; more: number; notes: string[];
}

export interface LocalReviewOptions { containerRoot?: string; vault: string; now: Date; max?: number }

const PROTECTED = new Set(['main', 'staging', 'develop']);
const BASES = ['staging', 'develop', 'main'];
const SEP = '\x1f';
const DEFAULT_MAX = 40;

const git = (repo: string, ...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The state of one unit's verdict at its current head: a row for this head decides; rows for other heads only mean "stale". */
export function verdictState(rows: readonly VerdictRow[], id: string, head: string): { state: VerdictState; at?: string } {
  const mine = rows.filter((r) => r.pr === id);
  const exact = mine.filter((r) => head.startsWith(r.head) || r.head.startsWith(head)).at(-1);
  if (exact) return { state: exact.verdict === 'SHIP IT' ? 'ship-it' : 'needs-work', at: exact.at };
  const old = mine.at(-1);
  return old ? { state: 'stale', at: old.at } : { state: 'none' };
}

/** Git repos directly under the container. */
function repoDirs(container: string): string[] {
  return readdirSync(container, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && statSync(join(container, d.name, '.git'), { throwIfNoEntry: false })?.isDirectory())
    .map((d) => d.name).sort();
}

/** branch -> worktree path, from `git worktree list --porcelain` (detached worktrees have no branch and are skipped). */
function worktrees(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  let path = '';
  for (const line of git(repo, 'worktree', 'list', '--porcelain').out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice(18), path);
  }
  return out;
}

/** `path` relative to `root`, or '' when it is not inside it. git reports real paths, so both sides are resolved first. */
function inside(root: string, path: string): string {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : '';
  } catch { return ''; }
}

function unitsIn(container: string, name: string, rows: readonly VerdictRow[]): LocalUnit[] {
  const repo = join(container, name);
  const remote = new Set(git(repo, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin').out.split('\n'));
  const base = BASES.find((b) => remote.has(b)) ?? 'main';
  const trees = worktrees(repo);
  const fmt = ['%(refname:short)', '%(objectname)', '%(committerdate:iso-strict)', '%(subject)'].join(SEP);
  const out: LocalUnit[] = [];
  for (const line of git(repo, 'for-each-ref', `--format=${fmt}`, 'refs/heads').out.split('\n').filter(Boolean)) {
    const [branch = '', head = '', at = '', subject = ''] = line.split(SEP);
    if (!branch || PROTECTED.has(branch) || remote.has(branch)) continue;
    const count = git(repo, 'rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes=origin');
    const ahead = count.ok && /^\d+$/.test(count.out) ? Number(count.out) : 0;
    if (ahead === 0) continue;
    const tree = trees.get(branch);
    const where = (tree && inside(container, tree)) || name;
    const id = localUnitId(name, branch);
    out.push({ id, repo: name, branch, head, ahead, at, subject, where, checkedOut: tree !== undefined, base: `origin/${base}`, command: `git -C ${quote(name)} difftool ${quote(`origin/${base}...${branch}`)}`, verdict: verdictState(rows, id, head) });
  }
  return out;
}

export function buildLocalReview(o: LocalReviewOptions): LocalReview {
  const generatedAt = o.now.toISOString();
  if (!o.containerRoot) return { generatedAt, available: false, reason: 'No container folder is configured (set container_root), so local branches are not read.', units: [], more: 0, notes: [] };
  let names: string[];
  try { names = repoDirs(o.containerRoot); } catch { return { generatedAt, available: false, reason: 'The configured container folder cannot be read.', units: [], more: 0, notes: [] }; }
  const rows = loadVerdicts(o.vault);
  const all = names.flatMap((n) => unitsIn(o.containerRoot as string, n, rows)).sort((a, b) => b.at.localeCompare(a.at));
  const max = o.max ?? DEFAULT_MAX;
  return { generatedAt, available: true, units: all.slice(0, max), more: Math.max(0, all.length - max), notes: ['Read from local git only: no fetch, so a branch pushed from another machine can show here until this one fetches.'] };
}
