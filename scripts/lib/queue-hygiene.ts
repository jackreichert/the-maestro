/**
 * Queue hygiene for the footer: how old the oldest queued row is, and how many queued rows already have a built branch.
 * A row is "built" when a tracker key it names (its `ticket` field, or any key in its text) appears in a local or remote-tracking
 * branch name of its repo, as a whole key (`MAESTRO-26` does not match `maestro-266`). Offline: it reads branch names only. A queued row that
 * names a merged PR needs GitHub, so that check lives in queue-report.ts and not in the footer.
 * Pure over the items and a branch lister; the caller supplies `branchesOf`, because only the caller touches git.
 */
import { spawnSync } from 'node:child_process';
import { daysBetween } from './boxes.ts';

export interface QueueRow { id?: string; text?: string; date?: string; ts?: string; repo?: string; ticket?: string }

export interface QueueHygiene {
    queued: number;
    /** Age in days of the oldest queued row, null with none. */
    oldestDays: number | null;
    oldestId: string | null;
    /** Ids of queued rows that already have a built branch, with the branch that matched. */
    built: { id: string; branch: string }[];
}

/** Tracker keys a row names: its ticket field plus every match of `pattern` in its text. */
export function keysOf(row: QueueRow, pattern: string): string[] {
    const found = new Set<string>();
    if (row.ticket) found.add(row.ticket);
    for (const m of (row.text ?? '').matchAll(new RegExp(pattern, 'g'))) found.add(m[0]);
    return [...found];
}

/** The first branch naming `key` as a whole key (not followed by another digit), case-insensitive. */
export function branchFor(key: string, branches: readonly string[]): string | undefined {
    const k = key.toLowerCase();
    return branches.find((b) => { const l = b.toLowerCase(); const at = l.indexOf(k); return at >= 0 && !/\d/.test(l[at + k.length] ?? '') && !/[a-z0-9]/.test(l[at - 1] ?? ''); });
}

export function queueHygiene(queued: readonly QueueRow[], today: string, pattern: string, branchesOf: (repo: string | undefined) => readonly string[]): QueueHygiene {
    let oldest: QueueRow | null = null;
    for (const r of queued) if (!oldest || (r.date ?? '9999') < (oldest.date ?? '9999')) oldest = r;
    const built: QueueHygiene['built'] = [];
    for (const r of queued) {
        const branches = branchesOf(r.repo);
        for (const key of keysOf(r, pattern)) {
            const branch = branchFor(key, branches);
            if (branch) { built.push({ id: r.id ?? '', branch }); break; }
        }
    }
    return { queued: queued.length, oldestDays: oldest ? daysBetween(oldest.date, today) : null, oldestId: oldest?.id ?? null, built };
}

/** Branch lister over real git: local and remote-tracking branch names of `dir`, empty when it is not a repo. A repo is listed once per call site (callers memoize). */
export function gitBranches(dir: string): string[] {
    const r = spawnSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** `**Queue:** oldest 6d; 4 of 25 already built (branch exists)`, or '' with nothing queued. */
export function queueFooter(h: QueueHygiene): string {
    if (!h.queued) return '';
    const age = h.oldestDays === null ? '' : `oldest ${h.oldestDays}d${h.oldestId ? ` (${h.oldestId})` : ''}`;
    const built = h.built.length ? `${h.built.length} of ${h.queued} already built (branch exists)` : '';
    return `**Queue:** ${[age, built].filter(Boolean).join('; ')}`;
}
