/**
 * The local review queue behind `GET /api/local-review`: branches in the container's repos that hold commits no origin ref has
 * and have no remote branch of the same name. A PR needs a pushed branch, so these are the finished-but-unpushed units waiting
 * for a local re-review before they go up. Read-only and offline: git only, never `gh`, never a fetch, never a write.
 * Each unit carries the re-review verdict recorded for its exact head commit (review-verdict.ts, id `local:<repo>#<branch>`);
 * a verdict recorded for an earlier head is shown as stale, never as a pass. Paths are relative to the container, never absolute.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { loadVerdicts, localUnitId, verdictFor } from '../../review-verdict.ts';
import type { VerdictRow } from '../../review-verdict.ts';
import { classifyCached } from './local-branch-class.ts';
import type { BranchClass, ClassCache, Run } from './local-branch-class.ts';

export type VerdictState = 'ship-it' | 'needs-work' | 'stale' | 'none';
export interface LocalUnit {
  id: string; repo: string; branch: string; head: string; ahead: number; at: string; subject: string;
  /** Container-relative folder of the branch's worktree; the repo's folder when it is not checked out, or its worktree sits outside the container. */
  where: string; checkedOut: boolean;
  /** The base the diff is against, and the command that opens it in the difftool. */
  base: string; command: string;
  verdict: { state: VerdictState; at?: string };
}
/**
 * What the queue leaves out and why. `landed` branches are already on their base, `superseded` ones share a ticket key with a base
 * commit (a guess, never offered for deletion), `special` are `local/*` overlays. `commands` is the paste block that deletes the
 * landed ones that are the user's own, each as `update-ref -d <ref> <scanned tip>` so git refuses it if the branch has moved since the scan and not checked out anywhere: one command per line, no comments. Nothing here ever runs.
 */
export interface Cleanup { landed: number; superseded: number; special: number; commands: string[] }
export const NO_CLEANUP: Cleanup = { landed: 0, superseded: 0, special: 0, commands: [] };

export interface LocalReview {
  generatedAt: string;
  /** False when there is nothing to read (no container configured); `reason` then says why, so "none" never stands in for "unknown". */
  available: boolean; reason?: string;
  /** Live work only, newest first. */
  units: LocalUnit[]; more: number; notes: string[];
  cleanup: Cleanup;
}

export interface LocalReviewOptions { containerRoot?: string; vault: string; now: Date; max?: number; classCache?: ClassCache }

const PROTECTED = new Set(['main', 'staging', 'develop']);
const BASES = ['staging', 'develop', 'main'];
const SEP = '\x1f';
const DEFAULT_MAX = 40;
const MAX_REPOS = 60;
const MAX_CLEANUP = 300;

const DEFAULT_BUDGET_MS = 60_000;
const CALL_MS = 15_000;

/** The wall-clock allowance for one scan; `spent` turns true once a call was refused or cut short for lack of time. */
interface Budget { until: number; spent: boolean }

/** One git call, never longer than what is left of the budget; an exhausted budget answers "not ok" without spawning. */
const git = (repo: string, budget: Budget, ...args: string[]): { ok: boolean; out: string } => {
  const left = budget.until - Date.now();
  if (left <= 0) { budget.spent = true; return { ok: false, out: '' }; }
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: Math.min(CALL_MS, left), maxBuffer: 64 * 1024 * 1024 });
  if (r.error) budget.spent = true;
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The state of one unit's verdict at its current head: a row for this head decides; rows for other heads only mean "stale". */
export function verdictState(rows: VerdictRow[], id: string, head: string): { state: VerdictState; at?: string } {
  const exact = verdictFor(rows, id, head);
  if (exact) return { state: exact.verdict === 'SHIP IT' ? 'ship-it' : 'needs-work', at: exact.at };
  const old = rows.filter((r) => r.pr === id).at(-1);
  return old ? { state: 'stale', at: old.at } : { state: 'none' };
}

const isRepo = (dir: string): boolean => statSync(join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() ?? false;
const subdirs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();

/**
 * Container-relative folders of the git repos in the container: its direct children, and one level further down inside a child
 * that is not itself a repo (`skills/the-maestro`). A linked worktree has a `.git` file, not a folder, so it is never listed
 * twice: its branches come from the owning repo's worktree list. At most `MAX_REPOS`, so a huge folder cannot make a long scan.
 */
function repoDirs(container: string): string[] {
  const found: string[] = [];
  for (const top of subdirs(container)) {
    if (isRepo(join(container, top))) { found.push(top); continue; }
    try { for (const sub of subdirs(join(container, top))) if (isRepo(join(container, top, sub))) found.push(join(top, sub)); } catch { /* an unreadable folder is skipped */ }
  }
  return found.slice(0, MAX_REPOS);
}

/** branch -> worktree path, from `git worktree list --porcelain` (detached worktrees have no branch and are skipped). */
function worktrees(repo: string, budget: Budget): Map<string, string> {
  const out = new Map<string, string>();
  let path = '';
  for (const line of git(repo, budget, 'worktree', 'list', '--porcelain').out.split('\n')) {
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

interface Candidate { folder: string; unit: LocalUnit; cls: BranchClass; mine: () => boolean }

/**
 * Local branches of one repo whose tip no origin ref contains, classified, without their commit counts (those are only worth
 * computing for the units shown). `mine` says whether every commit the branch has over its base is by this repo's own git user.
 */
function candidatesIn(container: string, folder: string, budget: Budget, cache: ClassCache): Candidate[] {
  const repo = join(container, folder);
  const name = basename(folder);
  const remote = new Set(git(repo, budget, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin').out.split('\n'));
  const base = BASES.find((b) => remote.has(b)) ?? 'main';
  const trees = worktrees(repo, budget);
  // One rev-list names every commit some branch has and no origin ref has; a branch is unpushed exactly when its tip is one of them.
  const unpushed = new Set(git(repo, budget, 'rev-list', '--branches', '--not', '--remotes=origin').out.split('\n'));
  const fmt = ['%(refname:short)', '%(objectname)', '%(committerdate:iso-strict)', '%(subject)'].join(SEP);
  const run: Run = (...args) => git(repo, budget, ...args);
  const baseSha = run('rev-parse', '--verify', `origin/${base}`).out;
  const me = run('config', 'user.email').out;
  const out: Candidate[] = [];
  for (const line of git(repo, budget, 'for-each-ref', `--format=${fmt}`, 'refs/heads').out.split('\n').filter(Boolean)) {
    const [branch = '', head = '', at = '', subject = ''] = line.split(SEP);
    if (!branch || PROTECTED.has(branch) || remote.has(branch) || !unpushed.has(head)) continue;
    const tree = trees.get(branch);
    const where = (tree && inside(container, tree)) || folder;
    const id = localUnitId(name, branch);
    let cls = classifyCached(cache, `${folder}\0${branch}`, run, `origin/${base}`, baseSha, branch, head);
    // A scan that ran dry mid-branch cannot vouch for its answer: keep it live and out of the cache.
    if (budget.spent) { delete cache[`${folder}\0${branch}`]; if (cls === 'landed') cls = 'live'; }
    const mine = (): boolean => {
      if (me === '') return false;
      const log = run('log', '--format=%ae', `origin/${base}..${branch}`);
      return log.ok && log.out.split('\n').filter(Boolean).every((a) => a === me);
    };
    out.push({ folder, cls, mine, unit: { id, repo: name, branch, head, ahead: 1, at, subject, where, checkedOut: tree !== undefined, base: `origin/${base}`, command: `git -C ${quote(folder)} difftool ${quote(`origin/${base}...${branch}`)}`, verdict: { state: 'none' } } });
  }
  return out;
}

const unavailable = (generatedAt: string, reason: string): LocalReview => ({ generatedAt, available: false, reason, units: [], more: 0, notes: [], cleanup: NO_CLEANUP });

/**
 * Read the container's repos and build the queue, without any recorded verdicts (every unit is `none`). This is the slow part:
 * it spawns git, so it runs in the snapshot producer (`local-review-snapshot.ts`), never inside a request.
 * It is bounded: at most MAX_REPOS repos, one commit count per shown unit, and `budgetMs` of wall time in all; past that it
 * stops asking git and says so in `notes`.
 */
export function scanLocalReview(o: LocalReviewOptions & { budgetMs?: number }): LocalReview {
  const generatedAt = o.now.toISOString();
  if (!o.containerRoot) return unavailable(generatedAt, 'No container folder is configured (set container_root), so local branches are not read.');
  const budget: Budget = { until: Date.now() + (o.budgetMs ?? DEFAULT_BUDGET_MS), spent: false };
  let folders: string[];
  try { folders = repoDirs(o.containerRoot); } catch { return unavailable(generatedAt, 'The configured container folder cannot be read.'); }
  const cache = o.classCache ?? {};
  const found = folders.flatMap((f) => candidatesIn(o.containerRoot as string, f, budget, cache));
  for (const k of Object.keys(cache)) if (!found.some((c) => `${c.folder}\0${c.unit.branch}` === k)) delete cache[k];
  const all = found.filter((c) => c.cls === 'live').sort((a, b) => b.unit.at.localeCompare(a.unit.at));
  const max = o.max ?? DEFAULT_MAX;
  const units = all.slice(0, max).map(({ folder, unit: u }) => {
    const r = git(join(o.containerRoot as string, folder), budget, 'rev-list', '--count', `refs/heads/${u.branch}`, '--not', '--remotes=origin');
    return r.ok && /^\d+$/.test(r.out) && Number(r.out) > 0 ? { ...u, ahead: Number(r.out) } : u;
  });
  const notes = ['Read from local git only: no fetch, so a branch pushed from another machine can show here until this one fetches.'];
  if (budget.spent) notes.push('The scan ran out of time, so this list may be incomplete and the commit counts may show 1.');
  return { generatedAt, available: true, units, more: Math.max(0, all.length - max), notes, cleanup: cleanupOf(found) };
}

/** The counts of what the queue leaves out, and the delete commands for landed branches that are the user's own and not checked out. */
function cleanupOf(found: Candidate[]): Cleanup {
  const count = (cls: BranchClass): number => found.filter((c) => c.cls === cls).length;
  const commands = found
    .filter((c) => c.cls === 'landed' && !c.unit.checkedOut && c.mine())
    .sort((a, b) => `${a.folder}\0${a.unit.branch}`.localeCompare(`${b.folder}\0${b.unit.branch}`))
    .slice(0, MAX_CLEANUP)
    .map((c) => `git -C ${quote(c.folder)} update-ref -d ${quote(`refs/heads/${c.unit.branch}`)} ${c.unit.head}`);
  return { landed: count('landed'), superseded: count('superseded'), special: count('special'), commands };
}

/** The scan with each unit's recorded verdict for its exact head applied; reading the verdict file is cheap, so this runs per request. */
export function withVerdicts(review: LocalReview, vault: string): LocalReview {
  if (!review.available || review.units.length === 0) return review;
  const rows = loadVerdicts(vault);
  return { ...review, units: review.units.map((u) => ({ ...u, verdict: verdictState(rows, u.id, u.head) })) };
}

/** Scan and apply verdicts in one go (spawns git: for tests and the producer, never for a request handler). */
export function buildLocalReview(o: LocalReviewOptions & { budgetMs?: number }): LocalReview {
  return withVerdicts(scanLocalReview(o), o.vault);
}
