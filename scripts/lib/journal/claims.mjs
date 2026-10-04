import { mkdirSync, readFileSync, unlinkSync, writeFileSync, linkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const claimPath = (claimsDir, repo) => join(claimsDir, `${repo}.lock`);
/** A plain repo name (letters, digits, . _ -); anything else is a usage error through `die`. */
export const validRepo = (die, r) => (r && /^[\w.-]+$/.test(r) && r !== '.' && r !== '..' ? r : die('Give a plain repo name (letters, digits, . _ -).'));

export function readClaim(claimsDir, repo) {
    try { return JSON.parse(readFileSync(claimPath(claimsDir, repo), 'utf8')); } catch { return null; }
}

export function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** { stale, reason } for a claim: its pid is dead on this host, or it is older than `hours`. A claim with no pid is judged on age alone. */
export function claimStaleness(c, hours) {
    const age = c?.time ? (Date.now() - Date.parse(c.time)) / 36e5 : Infinity;
    if (c?.pid && c.host === hostname() && !pidAlive(c.pid)) return { stale: true, reason: `pid ${c.pid} is not running`, ageHours: age };
    if (age > hours) return { stale: true, reason: `older than ${hours}h`, ageHours: age };
    return { stale: false, reason: null, ageHours: age };
}

export const describeClaim = (c) => (c ? `desk ${c.desk}, pid ${c.pid ?? 'unknown'}, host ${c.host}, since ${c.time}` : 'an unreadable claim');

/**
 * The guarantee is link(2): the full claim is written to a private temp file, then hard-linked to
 * Claims/<repo>.lock. link fails with EEXIST if the lock exists, so of any number of racing
 * processes exactly one succeeds, and the lock never exists half-written (an exclusive create
 * followed by a write exposes an empty file, which a loser reads as "an unreadable claim").
 * Returns the link error, or null when the lock was taken.
 */
export function acquireClaimLock(claimsDir, repo, claim) {
    mkdirSync(claimsDir, { recursive: true });
    const tmp = `${claimPath(claimsDir, repo)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(claim, null, 2) + '\n', { flag: 'wx' });
    let linkError = null;
    try { linkSync(tmp, claimPath(claimsDir, repo)); } catch (e) { linkError = e; }
    unlinkSync(tmp);
    return linkError;
}
