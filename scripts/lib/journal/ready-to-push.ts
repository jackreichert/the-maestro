/**
 * `journal.ts ready-to-push`: local branches whose work is held back, not yet on any remote. Read-only git over the repos of the
 * container. A branch is listed when it is not protected, has at least one commit that no remote ref contains, and every such commit
 * is authored by one of the user's own emails (someone else's work is never listed as mine to push).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HeldBranch { repo: string; branch: string; tip: string; unpushed: number; lastCommit: string; keyed: boolean; hasRemoteBranch: boolean }

const git = (repo: string, ...args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};
const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
/** `main`, `release/*` style globs, as the protected_branches setting writes them. */
const matchesGlob = (name: string, glob: string): boolean => new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`).test(name);

/** The held branches of one repo, newest commit first. A directory that is not a git repository gives none. */
export function heldBranches(repoDir: string, repo: string, opts: { emails: readonly string[]; protectedNames: readonly string[]; keyPattern: string }): HeldBranch[] {
    const heads = git(repoDir, 'for-each-ref', '--format=%(refname:short)%09%(objectname:short)', 'refs/heads');
    if (!heads.ok || !heads.out) return [];
    const emails = new Set(opts.emails.map((e) => e.toLowerCase()));
    const key = new RegExp(opts.keyPattern);
    const remoteNames = new Set(git(repoDir, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes').out.split('\n'));
    const out: HeldBranch[] = [];
    for (const line of heads.out.split('\n')) {
        const [branch = '', tip = ''] = line.split('\t');
        if (!branch || opts.protectedNames.some((g) => matchesGlob(branch, g))) continue;
        const own = git(repoDir, 'log', '--format=%ae%x09%cI', branch, '--not', '--remotes');
        const commits = own.ok && own.out ? own.out.split('\n').map((l) => l.split('\t')) : [];
        if (!commits.length) continue;
        if (!commits.every(([email]) => emails.has((email ?? '').toLowerCase()))) continue;
        out.push({ repo, branch, tip, unpushed: commits.length, lastCommit: commits[0]?.[1] ?? '', keyed: key.test(branch), hasRemoteBranch: remoteNames.has(branch) });
    }
    return out.sort((a, b) => b.lastCommit.localeCompare(a.lastCommit));
}

/** Every git repository directly under the container (or just `only`), as [name, dir]. */
export function containerRepos(root: string, only?: string): [string, string][] {
    if (!root || !existsSync(root)) return [];
    const names = only ? [only] : readdirSync(root).sort();
    return names.filter((n) => existsSync(join(root, n, '.git'))).map((n): [string, string] => [n, join(root, n)]);
}

export const heldLines = (held: HeldBranch[]): string[] => (held.length
    ? held.map((h) => `  ${h.repo}  ${h.branch}  ${h.tip}  ${h.unpushed} unpushed${h.hasRemoteBranch ? ' (branch is on a remote; newer commits are not)' : ''}${h.keyed ? '' : '  NO TRACKER KEY (rename before any push)'}  ${h.lastCommit.slice(0, 10)}`)
    : ['No held branches.']);
