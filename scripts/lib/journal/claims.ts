import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, linkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** A claim lock file: which desk holds a repo, from where and since when. */
export interface ClaimFile { repo?: string; desk?: string; pid?: number | null; host?: string; time?: string; branch?: string; why?: string }

/**
 * A claim is keyed by repo alone (the legacy, whole-repo lock `<repo>.lock`) or by repo and scope (`<repo>@<scope>.lock`), the scope being a
 * worktree name or branch. `@` is outside the repo-name alphabet, so a key splits unambiguously. Two claims on one repo coexist only when both
 * are scoped and their scopes differ: a whole-repo claim, old or new, conflicts with every other claim on the repo.
 */
export const claimScope = (s: string | undefined | null): string | undefined => (s ?? '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || undefined;
export const claimKey = (repo: string, scope?: string): string => (scope ? `${repo}@${scope}` : repo);
export const splitClaimKey = (key: string): { repo: string; scope?: string } => { const at = key.indexOf('@'); return at < 0 ? { repo: key } : { repo: key.slice(0, at), scope: key.slice(at + 1) }; };
export const scopesConflict = (a?: string, b?: string): boolean => !a || !b || a === b;
/** Keys of the claim locks on a repo (whole-repo and scoped), sorted. */
export function claimKeysFor(claimsDir: string, repo: string): string[] {
    if (!existsSync(claimsDir)) return [];
    return readdirSync(claimsDir).filter((f) => f.endsWith('.lock')).map((f) => f.slice(0, -5)).filter((k) => k === repo || k.startsWith(`${repo}@`)).sort();
}

export const claimPath = (claimsDir: string, repo: string): string => join(claimsDir, `${repo}.lock`);
/** A plain repo name (letters, digits, . _ -); anything else is a usage error through `die`. */
export const validRepo = (die: (message: string) => never, r: string | undefined): string => (r && /^[\w.-]+$/.test(r) && r !== '.' && r !== '..' ? r : die('Give a plain repo name (letters, digits, . _ -).'));

/** The claim in a repo's lock file, or null when the file is missing, not JSON, or not a JSON object (a bare number or array is not a claim). */
export function readClaim(claimsDir: string, repo: string): ClaimFile | null {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(claimPath(claimsDir, repo), 'utf8')); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // A JSON object; its fields are not checked, and the callers read them with ?. and fall back.
    return parsed as ClaimFile;
}

export function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return e instanceof Error && 'code' in e && e.code === 'EPERM'; }
}

/** { stale, reason } for a claim: its pid is dead on this host, or it is older than `hours`. A claim with no pid is judged on age alone. */
export function claimStaleness(c: ClaimFile | null, hours: number): { stale: boolean; reason: string | null; ageHours: number } {
    const age = c?.time ? (Date.now() - Date.parse(c.time)) / 36e5 : Infinity;
    if (c?.pid && c.host === hostname() && !pidAlive(c.pid)) return { stale: true, reason: `pid ${c.pid} is not running`, ageHours: age };
    if (age > hours) return { stale: true, reason: `older than ${hours}h`, ageHours: age };
    return { stale: false, reason: null, ageHours: age };
}

export const describeClaim = (c: ClaimFile | null): string => (c ? `desk ${c.desk}, pid ${c.pid ?? 'unknown'}, host ${c.host}, since ${c.time}` : 'an unreadable claim');

/**
 * The guarantee is link(2): the full claim is written to a private temp file, then hard-linked to
 * Claims/<repo>.lock. link fails with EEXIST if the lock exists, so of any number of racing
 * processes exactly one succeeds, and the lock never exists half-written (an exclusive create
 * followed by a write exposes an empty file, which a loser reads as "an unreadable claim").
 * Returns the link error, or null when the lock was taken.
 */
export function acquireClaimLock(claimsDir: string, repo: string, claim: ClaimFile): Error | null {
    mkdirSync(claimsDir, { recursive: true });
    const tmp = `${claimPath(claimsDir, repo)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(claim, null, 2) + '\n', { flag: 'wx' });
    let linkError: Error | null = null;
    try { linkSync(tmp, claimPath(claimsDir, repo)); } catch (e) { linkError = e instanceof Error ? e : new Error(String(e)); }
    unlinkSync(tmp);
    return linkError;
}

/** Outcome of {@link acquireRepoClaim}: taken, or refused because the same key (`exists`) or another claim that conflicts with it (`conflict`) is held. */
export type RepoClaimOutcome = { status: 'taken' } | { status: 'exists' | 'conflict'; key: string; held: ClaimFile | null };

/**
 * Takes the claim for a repo and scope. The own-key link is the atomic step; a conflicting claim under another key is checked before and
 * after it (`lock` is injectable so a test can land the rival between the two), and the second check backs the own claim out again, so a whole-repo claim and a scoped one racing never both stand (at worst both back off).
 */
export function acquireRepoClaim(claimsDir: string, repo: string, scope: string | undefined, claim: ClaimFile, lock: typeof acquireClaimLock = acquireClaimLock): RepoClaimOutcome {
    const key = claimKey(repo, scope);
    const conflicting = (): string | undefined => claimKeysFor(claimsDir, repo).find((k) => k !== key && scopesConflict(scope, splitClaimKey(k).scope));
    const before = conflicting();
    if (before) return { status: 'conflict', key: before, held: readClaim(claimsDir, before) };
    const linkError = lock(claimsDir, key, claim);
    if (linkError) {
        if (!('code' in linkError && linkError.code === 'EEXIST')) throw linkError;
        return { status: 'exists', key, held: readClaim(claimsDir, key) };
    }
    const after = conflicting();
    if (after) {
        unlinkSync(claimPath(claimsDir, key));
        return { status: 'conflict', key: after, held: readClaim(claimsDir, after) };
    }
    return { status: 'taken' };
}
