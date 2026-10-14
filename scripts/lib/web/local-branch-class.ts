/**
 * Sorts an unpushed local branch into what it still is, so the review queue counts live work only.
 *   landed      every commit's patch is already on the base (`git cherry` all `-`), nothing is ahead, or every file it touches equals the base.
 *   superseded  a ticket key in the branch name appears in a base commit message. A weak signal (the work may have landed in other
 *               shape), so it is counted but never offered for deletion.
 *   special     `local/*` overlay branches, kept on purpose.
 *   live        everything else: real unpushed work.
 * Git only, through the caller's `run`; the result is cached per branch tip and base commit, so a refresh only re-reads what moved.
 */
export type BranchClass = 'landed' | 'superseded' | 'special' | 'live';
export type Run = (...args: string[]) => { ok: boolean; out: string };
export interface ClassEntry { head: string; base: string; cls: BranchClass }
export type ClassCache = Record<string, ClassEntry>;

const KEY = /[A-Za-z]{2,10}-\d+/g;

/** Every touched file already has the base's content: the branch adds nothing even when its commits were squashed or reworded. */
function touchesNothingNew(run: Run, base: string, branch: string): boolean {
  const files = run('diff', '--no-renames', '--name-only', '-z', `${base}...${branch}`);
  if (!files.ok) return false;
  // Fail closed: a file counts as unchanged only when both lookups succeed with the same object. Two failures (a refused call,
  // a file gone on both sides) never read as equal, so an unreadable branch stays live.
  return files.out.split('\0').filter(Boolean).every((f) => {
    // ls-tree prints mode, type and object, so a mode-only change (chmod +x) differs too. Literal pathspecs: a name is never a glob.
    const onBase = run('--literal-pathspecs', 'ls-tree', base, '--', f);
    const onBranch = run('--literal-pathspecs', 'ls-tree', branch, '--', f);
    return onBase.ok && onBranch.ok && onBase.out !== '' && onBase.out === onBranch.out;
  });
}

/** True when a ticket key from the branch name appears in a base commit message. */
function keyLandedOnBase(run: Run, base: string, branch: string): boolean {
  const keys = new Set((branch.match(KEY) ?? []).map((k) => k.toUpperCase()));
  return [...keys].some((k) => run('log', base, '-i', '-1', '--format=%h', `--grep=${k}`).out !== '');
}

/** Classify without the cache. A git failure never reads as landed: it falls through to live, the side that costs a look, not a lost branch. */
export function classifyBranch(run: Run, base: string, branch: string): BranchClass {
  if (branch.startsWith('local/')) return 'special';
  const ahead = run('rev-list', '--count', `${base}..${branch}`);
  if (ahead.ok && ahead.out === '0') return 'landed';
  // git cherry skips merge commits, so content that lives only in a merge (a conflict resolution, edits made with --no-commit) is
  // invisible to it: such a branch is judged on its files alone.
  const merges = run('rev-list', '--merges', '--count', `${base}..${branch}`);
  const cherry = merges.ok && merges.out === '0' ? run('cherry', base, branch) : { ok: false, out: '' };
  if (cherry.ok && cherry.out.split('\n').filter(Boolean).every((l) => l.startsWith('-')) && ahead.ok) return 'landed';
  if (touchesNothingNew(run, base, branch)) return 'landed';
  return keyLandedOnBase(run, base, branch) ? 'superseded' : 'live';
}

/** `classifyBranch` through the cache: a hit needs the same branch tip and the same base commit. Writes the entry back. */
export function classifyCached(cache: ClassCache, key: string, run: Run, base: string, baseSha: string, branch: string, head: string): BranchClass {
  const hit = cache[key];
  if (hit && hit.head === head && hit.base === baseSha && baseSha !== '') return hit.cls;
  const cls = classifyBranch(run, base, branch);
  cache[key] = { head, base: baseSha, cls };
  return cls;
}
