// Run: node --test scripts/lib/journal/ready-to-push.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerRepos, heldBranches, heldLines } from './ready-to-push.ts';

const ME = 'me@example.com';
const OPTS = { emails: [ME], protectedNames: ['main', 'release/*'], keyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b' };

function sh(cwd: string, email: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}
const commit = (cwd: string, email: string, file: string): void => { writeFileSync(join(cwd, file), file); sh(cwd, email, 'add', file); sh(cwd, email, 'commit', '-q', '-m', file); };

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'held-'));
    const origin = join(root, 'origin.git');
    mkdirSync(origin);
    sh(origin, ME, 'init', '-q', '--bare', '-b', 'main');
    const dir = join(root, 'container', 'proj');
    mkdirSync(dir, { recursive: true });
    sh(dir, ME, 'init', '-q', '-b', 'main');
    sh(dir, ME, 'remote', 'add', 'origin', origin);
    commit(dir, ME, 'base.txt');
    sh(dir, ME, 'push', '-q', 'origin', 'main');
    return { container: join(root, 'container'), dir };
}

test('lists my unpushed keyed and unkeyed branches, never protected, pushed or someone else\'s work', () => {
    const { container, dir } = fixture();
    sh(dir, ME, 'switch', '-q', '-c', 'feat/MAESTRO-1-held'); commit(dir, ME, 'a.txt');
    sh(dir, ME, 'switch', '-q', '-c', 'scratch', 'main'); commit(dir, ME, 'b.txt');
    sh(dir, ME, 'switch', '-q', '-c', 'feat/MAESTRO-2-pushed', 'main'); commit(dir, ME, 'c.txt'); sh(dir, ME, 'push', '-q', 'origin', 'feat/MAESTRO-2-pushed');
    sh(dir, ME, 'switch', '-q', '-c', 'feat/MAESTRO-3-theirs', 'main'); commit(dir, 'other@example.com', 'd.txt');
    sh(dir, ME, 'switch', '-q', 'main');
    const held = heldBranches(dir, 'proj', OPTS);
    assert.deepEqual(held.map((h) => h.branch).sort(), ['feat/MAESTRO-1-held', 'scratch']);
    assert.equal(held.find((h) => h.branch === 'scratch')?.keyed, false);
    assert.equal(held.find((h) => h.branch === 'feat/MAESTRO-1-held')?.unpushed, 1);
    assert.match(heldLines(held).join('\n'), /scratch.*NO TRACKER KEY/);
    assert.deepEqual(containerRepos(container).map(([n]) => n), ['proj']);
    assert.deepEqual(containerRepos(container, 'none'), []);
});

test('a branch pushed and then extended lists only the newer commits; a non-repo gives nothing', () => {
    const { container, dir } = fixture();
    sh(dir, ME, 'switch', '-q', '-c', 'feat/MAESTRO-4-more'); commit(dir, ME, 'a.txt'); sh(dir, ME, 'push', '-q', 'origin', 'feat/MAESTRO-4-more'); commit(dir, ME, 'b.txt');
    const [h] = heldBranches(dir, 'proj', OPTS);
    assert.equal(h?.unpushed, 1);
    assert.equal(h?.hasRemoteBranch, true);
    assert.deepEqual(heldBranches(container, 'container', OPTS), []);
});
