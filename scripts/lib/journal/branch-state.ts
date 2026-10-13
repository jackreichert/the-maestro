import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BranchState } from './age-out.ts';

/**
 * Where a named branch stands in a local clone: `merged` when it is an ancestor of the default branch, `gone` when neither a local
 * nor a remote-tracking ref exists, `live` otherwise. Null when there is no clone or git cannot tell, and a null proposes nothing.
 * Reads local refs only (no fetch), so it is as fresh as the clone's last fetch.
 */
export function branchState(root: string | undefined, repo: string | undefined, name: string): BranchState | null {
    if (!root || !repo || repo.includes('/') || repo.includes('..')) return null;
    const dir = join(root, repo);
    if (!existsSync(join(dir, '.git'))) return null;
    const git = (args: string[]): { ok: boolean; out: string } => {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
        return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
    };
    const base = ['origin/main', 'origin/master', 'main', 'master'].find((b) => git(['rev-parse', '--verify', '--quiet', b]).ok);
    if (!base) return null;
    const ref = [`refs/remotes/origin/${name}`, `refs/heads/${name}`].find((r) => git(['rev-parse', '--verify', '--quiet', r]).ok);
    if (!ref) return 'gone';
    return git(['merge-base', '--is-ancestor', ref, base]).ok ? 'merged' : 'live';
}
