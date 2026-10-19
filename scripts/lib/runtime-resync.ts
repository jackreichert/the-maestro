/**
 * RUNTIME RESYNC: keep the loop daemon's checkout on origin/main.
 *
 * The daemon (launchd label `com.jackreichert.the-maestro-loop`) runs from a detached worktree, the "runtime". Nothing moved it when a PR
 * merged, so a merged fix stayed dead until someone fast-forwarded and restarted it by hand. `resyncRuntime` does that, and only when it is
 * safe: the worktree is clean, origin/main is a pure fast-forward of it, and GitHub reports a green `test` check for that exact commit.
 * Then it kickstarts the daemon. Already current is a no-op (no restart). Every git, gh and launchctl call comes in through `ResyncDeps`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { toolCommand } from './tool-bin.ts';
import { LABEL, plistPath } from './supervisor-state.ts';

export type ResyncAction = 'current' | 'resynced' | 'refused' | 'error';
export interface ResyncResult { action: ResyncAction; old?: string; new?: string; reason?: string }
export interface Run { status: number; stdout: string }

export interface ResyncDeps {
  /** Runs `git <args>` in the runtime worktree. */
  git: (args: string[]) => Run;
  /** The conclusion of the CI check named `test` on `sha` (`success`, `failure`, ...), or undefined when it is missing or unreadable. */
  ciConclusion: (sha: string) => string | undefined;
  /** `launchctl kickstart -k` for the daemon; true when it exited 0. */
  kickstart: () => boolean;
  log: (line: string) => void;
}

const short = (sha: string): string => sha.slice(0, 8);

/** Fast-forward the runtime to origin/main and restart the daemon, or say why not. Never throws on a refusal. */
export function resyncRuntime(deps: ResyncDeps): ResyncResult {
  const refuse = (reason: string, old?: string, target?: string): ResyncResult => {
    deps.log(`runtime-resync: refused, ${reason}`);
    return { action: 'refused', reason, ...(old ? { old } : {}), ...(target ? { new: target } : {}) };
  };
  if (deps.git(['fetch', '--quiet', 'origin', 'main']).status !== 0) return refuse('git fetch origin main failed');
  const head = deps.git(['rev-parse', 'HEAD']);
  const main = deps.git(['rev-parse', 'refs/remotes/origin/main']);
  const old = head.stdout.trim();
  const target = main.stdout.trim();
  if (head.status !== 0 || main.status !== 0 || !old || !target) return refuse('cannot read HEAD or origin/main');
  if (old === target) { deps.log(`runtime-resync: current at ${short(old)}`); return { action: 'current', old, new: target }; }
  const dirty = deps.git(['status', '--porcelain']);
  if (dirty.status !== 0 || dirty.stdout.trim()) return refuse('runtime worktree is not clean', old, target);
  if (deps.git(['merge-base', '--is-ancestor', old, target]).status !== 0) return refuse(`${short(target)} is not a fast-forward of ${short(old)}`, old, target);
  const ci = deps.ciConclusion(target);
  if (ci !== 'success') return refuse(`CI test on ${short(target)} is ${ci ?? 'unreadable'}, not success`, old, target);
  if (deps.git(['merge', '--ff-only', target]).status !== 0) return refuse(`git merge --ff-only ${short(target)} failed`, old, target);
  if (!deps.kickstart()) {
    deps.log(`runtime-resync: moved ${short(old)} -> ${short(target)} but launchctl kickstart failed; the daemon is still the old process`);
    return { action: 'error', old, new: target, reason: 'launchctl kickstart failed' };
  }
  deps.log(`runtime-resync: ${short(old)} -> ${short(target)}, daemon restarted`);
  return { action: 'resynced', old, new: target };
}

/** The runtime worktree: MAESTRO_RUNTIME_WORKTREE, else the repo the installed plist launches the supervisor from; undefined when neither exists. */
export function runtimeWorktree(env: NodeJS.ProcessEnv = process.env, plist: string = plistPath()): string | undefined {
  if (env.MAESTRO_RUNTIME_WORKTREE) return env.MAESTRO_RUNTIME_WORKTREE;
  try {
    if (!existsSync(plist)) return undefined;
    return /<string>([^<]+)\/scripts\/loop-supervisor\.ts<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1];
  } catch { return undefined; }
}

/** `owner/repo` of a GitHub remote url, or undefined. */
export const slugOf = (url: string): string | undefined => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(url.trim())?.[1];

const gitIn = (cwd: string) => (args: string[]): Run => {
  const [bin, binArgs] = toolCommand('git', args);
  const r = spawnSync(bin, binArgs, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

/** The real deps for a runtime worktree: git in that directory, gh for the `test` check, launchctl for the restart. */
export function liveDeps(cwd: string, log: (line: string) => void = (l) => console.log(l)): ResyncDeps {
  const git = gitIn(cwd);
  return {
    git,
    log,
    ciConclusion: (sha) => {
      const slug = slugOf(git(['remote', 'get-url', 'origin']).stdout);
      if (!slug || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
      const [bin, args] = toolCommand('gh', ['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`, '--jq', '[.check_runs[] | select(.name == "test") | .conclusion] | join(",")']);
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
      const out = (r.stdout ?? '').trim();
      // Several runs named test (a re-run) must all be green; an in-progress run has a null conclusion and reads as not success.
      return r.status === 0 && out ? (out.split(',').every((c) => c === 'success') ? 'success' : out) : undefined;
    },
    kickstart: () => spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${LABEL}`], { timeout: 30_000 }).status === 0,
  };
}

/** How far the runtime is behind the local origin/main ref (no fetch, so it is cheap enough for the footer), or null when current or unreadable. */
export function runtimeBehind(git: (args: string[]) => Run): { runtime: string; main: string; behind: number } | null {
  try {
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const main = git(['rev-parse', 'refs/remotes/origin/main']).stdout.trim();
    if (!head || !main || head === main) return null;
    const n = Number(git(['rev-list', '--count', `${head}..${main}`]).stdout.trim());
    return Number.isFinite(n) && n > 0 ? { runtime: head, main, behind: n } : null;
  } catch { return null; }
}

/** The footer warning (no leading marker; loop-health-live joins it onto the `Loop:` line), or '' when the runtime is current, unknown, or not behind. */
export function runtimeStaleLine(cwd: string | undefined = runtimeWorktree()): string {
  if (!cwd || !existsSync(cwd)) return '';
  const b = runtimeBehind(gitIn(cwd));
  return b ? `runtime STALE, loop daemon at ${short(b.runtime)} is ${b.behind} commit${b.behind === 1 ? '' : 's'} behind origin/main ${short(b.main)} (merge-sweep --resync-runtime)` : '';
}
