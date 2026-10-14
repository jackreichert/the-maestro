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
  const files = run('diff', '--name-only', `${base}...${branch}`);
  if (!files.ok) return false;
  return files.out.split('\n').filter(Boolean).every((f) => {
    const onBase = run('rev-parse', '-q', '--verify', `${base}:${f}`);
    const onBranch = run('rev-parse', '-q', '--verify', `${branch}:${f}`);
    return onBase.ok === onBranch.ok && onBase.out === onBranch.out;
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
  const cherry = run('cherry', base, branch);
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
