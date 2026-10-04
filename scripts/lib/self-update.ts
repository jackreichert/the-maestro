/**
 * Session-start update check: is this skill's own checkout behind, ahead of or diverged from its upstream?
 *
 * `checkForUpdate` fetches, counts commits each way and reports one compact line, or an empty string when the
 * checkout is current. With `autoPull` on, a clean checkout that is purely behind is fast-forwarded with
 * `git merge --ff-only` and nothing else: no merge, rebase or reset is ever run, so local work cannot be lost.
 * Every git failure degrades to a reported line or silence; the check never throws.
 */
import { spawnSync } from 'node:child_process';

/** Runs `git -C <repo> <args>`. Tests inject a fake; the default is a real git with a timeout. */
export type GitRun = (args: string[], timeoutMs?: number) => { status: number | null; stdout: string };

export type UpdateState = 'current' | 'behind' | 'ahead' | 'diverged' | 'dirty' | 'pulled' | 'unchecked';
export interface UpdateReport { state: UpdateState; behind: number; ahead: number; dirty: boolean; upstream: string; line: string }
export interface UpdateOptions { repo: string; autoPull: boolean; name?: string; git?: GitRun; fetchTimeoutMs?: number }

const FETCH_TIMEOUT_MS = 15_000;

/** A real git against `repo`; a missing git binary or a timeout reads as a non-zero status. */
export const gitIn = (repo: string): GitRun => (args, timeoutMs = 10_000) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.status, stdout: r.stdout ?? '' };
};

const silent = (upstream = ''): UpdateReport => ({ state: 'unchecked', behind: 0, ahead: 0, dirty: false, upstream, line: '' });

/** Fetches and reports. Not a git checkout, a detached HEAD or a branch with no upstream are silent: nothing to compare. */
export function checkForUpdate(opts: UpdateOptions): UpdateReport {
  const git = opts.git ?? gitIn(opts.repo);
  const name = opts.name ?? 'the-maestro';
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.status !== 0) return silent();
  const up = upstream.stdout.trim();
  if (git(['fetch', '--quiet'], opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS).status !== 0) {
    return { ...silent(up), line: `${name}: update check could not fetch ${up} (offline or no access); not checked.` };
  }
  const counts = git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (counts.status !== 0 || !Number.isInteger(ahead) || !Number.isInteger(behind)) return silent(up);
  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 && status.stdout.trim() !== '';
  const base = { behind, ahead, dirty, upstream: up };

  if (behind > 0 && ahead === 0 && !dirty && opts.autoPull) {
    if (git(['merge', '--ff-only', '@{u}'], 30_000).status === 0) {
      return { ...base, state: 'pulled', line: `${name}: auto_pull fast-forwarded ${behind} commit(s) from ${up}.` };
    }
  }
  const tail = dirty ? ' Uncommitted changes.' : '';
  if (behind > 0 && ahead > 0) return { ...base, state: 'diverged', line: `${name}: diverged from ${up} (${ahead} ahead, ${behind} behind); resolve by hand.${tail}` };
  if (behind > 0) return { ...base, state: 'behind', line: `${name}: ${behind} commit(s) behind ${up}.${tail} ${dirty ? 'Commit or stash, then' : 'Run'} \`git pull --ff-only\`${opts.autoPull ? '' : ' (or set auto_pull: on)'}.` };
  if (ahead > 0) return { ...base, state: 'ahead', line: `${name}: ${ahead} commit(s) ahead of ${up}, not pushed.${tail}` };
  if (dirty) return { ...base, state: 'dirty', line: `${name}: uncommitted changes in the skill checkout.` };
  return { ...base, state: 'current', line: '' };
}
