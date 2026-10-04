// Run: node --test scripts/lib/journal/claims.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireClaimLock, claimPath, claimStaleness, describeClaim, pidAlive, readClaim, validRepo } from './claims.ts';

const dir = () => join(mkdtempSync(join(tmpdir(), 'claims-')), 'Claims');

test('validRepo accepts plain names and sends everything else to die', () => {
    const die = (message: string): never => { throw new Error(message); };
    assert.equal(validRepo(die, 'my-repo_1.x'), 'my-repo_1.x');
    for (const bad of [undefined, '', '.', '..', 'a/b', 'a b']) assert.throws(() => validRepo(die, bad), /plain repo name/);
});

test('acquireClaimLock takes the lock once, leaves no temp file, and reports EEXIST to the loser', () => {
    const claimsDir = dir();
    const claim = { repo: 'proj', desk: 'Alpha', pid: process.pid, host: hostname(), time: new Date().toISOString() };
    assert.equal(acquireClaimLock(claimsDir, 'proj', claim), null);
    assert.deepEqual(readdirSync(claimsDir), ['proj.lock']);
    assert.deepEqual(readClaim(claimsDir, 'proj'), claim);
    const lost = acquireClaimLock(claimsDir, 'proj', { ...claim, desk: 'Beta' });
    assert.equal(lost && 'code' in lost ? lost.code : null, 'EEXIST');
    assert.equal(readClaim(claimsDir, 'proj')?.desk, 'Alpha', 'the winner is untouched');
    assert.deepEqual(readdirSync(claimsDir), ['proj.lock']);
});

test('readClaim returns null for a missing or unreadable file', () => {
    const claimsDir = dir();
    assert.equal(readClaim(claimsDir, 'none'), null);
    acquireClaimLock(claimsDir, 'junk', {});
    writeFileSync(claimPath(claimsDir, 'junk'), 'not json');
    assert.equal(readClaim(claimsDir, 'junk'), null);
    assert.equal(existsSync(claimPath(claimsDir, 'junk')), true);
});

test('readClaim treats a lock file holding a bare number, array, string or null as unreadable, and it reads as stale', () => {
    const claimsDir = dir();
    for (const body of ['42', '[1,2]', '"held"', 'null']) {
        acquireClaimLock(claimsDir, 'odd', {});
        writeFileSync(claimPath(claimsDir, 'odd'), body);
        const claim = readClaim(claimsDir, 'odd');
        assert.equal(claim, null, body);
        assert.equal(describeClaim(claim), 'an unreadable claim');
        assert.equal(claimStaleness(claim, 12).stale, true);
    }
});

test('claimStaleness judges a dead pid on this host, then age, and describeClaim names the holder', () => {
    const fresh = new Date().toISOString();
    assert.equal(pidAlive(process.pid), true);
    assert.deepEqual(claimStaleness({ pid: process.pid, host: hostname(), time: fresh }, 12).stale, false);
    const dead = claimStaleness({ pid: 2 ** 22 + 12345, host: hostname(), time: fresh }, 12);
    assert.deepEqual([dead.stale, dead.reason], [true, `pid ${2 ** 22 + 12345} is not running`]);
    const old = claimStaleness({ host: 'elsewhere', time: new Date(Date.now() - 20 * 36e5).toISOString() }, 12);
    assert.deepEqual([old.stale, old.reason], [true, 'older than 12h']);
    assert.equal(claimStaleness(null, 12).stale, true, 'no claim reads as infinitely old');
    assert.equal(describeClaim(null), 'an unreadable claim');
    assert.equal(describeClaim({ desk: 'Alpha', host: 'h', time: 't' }), 'desk Alpha, pid unknown, host h, since t');
});
