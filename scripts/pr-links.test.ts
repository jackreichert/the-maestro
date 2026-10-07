// Run: node --test scripts/pr-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { diffAnchor, expandTokens, tokenPaths } from './pr-links.ts';

const OPEN = new URL('./pr-open.ts', import.meta.url).pathname;
const LINKS = new URL('./pr-guide-links.ts', import.meta.url).pathname;
const PR = 'https://github.com/example/demo/pull/7';

test('diffAnchor is diff- plus the sha256 hex of the path (vector checked against a real PR files page)', () => {
    assert.equal(diffAnchor('scripts/pr-open.ts'), 'diff-7a90e37c2fdb03ff71b52eb393dead0266142482a077bb312de69a25981489d4');
    assert.match(diffAnchor('src/widgets/alpha.ts'), /^diff-[0-9a-f]{64}$/);
    assert.notEqual(diffAnchor('src/a.ts'), diffAnchor('src/b.ts'));
});

test('expandTokens links known paths, shows a line as text, and leaves unknown paths and plain text alone', () => {
    const body = 'Start at {{file:src/widgets/alpha.ts}}, then {{file:src/widgets/alpha.ts#R42}} and {{file:src/gone.ts}}. Plain text stays.';
    const r = expandTokens(body, `${PR}/`, ['src/widgets/alpha.ts', 'src/widgets/beta.ts']);
    assert.equal(r.expanded, 2);
    assert.deepEqual(r.unknown, ['src/gone.ts']);
    assert.ok(r.body.includes(`[src/widgets/alpha.ts](${PR}/files#${diffAnchor('src/widgets/alpha.ts')})`));
    assert.ok(r.body.includes(`[src/widgets/alpha.ts:42](${PR}/files#${diffAnchor('src/widgets/alpha.ts')})`), 'a line is text, not an unverified anchor');
    assert.ok(r.body.includes('{{file:src/gone.ts}}') && r.body.endsWith('Plain text stays.'));
});

test('expandTokens is idempotent: an expanded body expands to itself', () => {
    const once = expandTokens('See {{file:src/a.ts}}.', PR, ['src/a.ts']);
    const twice = expandTokens(once.body, PR, ['src/a.ts']);
    assert.equal(twice.body, once.body);
    assert.equal(twice.expanded, 0);
    assert.deepEqual(tokenPaths(once.body), []);
});

const git = (repo: string, ...args: string[]): void => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

/** A repo whose feature branch changes `src/widgets/alpha.ts`, plus a fake gh serving create, view and edit. */
function fixture() {
    const repo = mkdtempSync(join(tmpdir(), 'pr-links-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(repo, 'README.keep'), 'keep\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(repo, 'src/widgets'), { recursive: true });
    writeFileSync(join(repo, 'src/widgets/alpha.ts'), 'export const a = 1;\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-q', '-m', 'change');
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
    const log = join(dir, 'gh.log');
    const edited = join(dir, 'edited.md');
    const view = join(dir, 'view.json');
    writeFileSync(view, JSON.stringify({ url: PR, body: 'See {{file:src/widgets/alpha.ts}}.', files: [{ path: 'src/widgets/alpha.ts' }] }));
    const gh = join(dir, 'gh.sh');
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1 $2" in\n"pr create") echo '${PR}' ;;\n"pr view") cat '${view}' ;;\n"pr edit") cp "$5" '${edited}' ;;\nesac\n`);
    chmodSync(gh, 0o755);
    return { repo, dir, log, edited, view, gh, env: { PATH: process.env.PATH, HOME: repo, MAESTRO_LOCAL_CONFIG: '', MAESTRO_GH_BIN: gh } };
}

const BODY = (guide: string): string => ['## Context', 'Why.', '## Reviewer guide', guide, '## Risk and blast radius', 'Risk: low - tool.', '## Rollback / flag', 'Plain revert.', '## How to verify locally', '```', 'npm test', '```', ''].join('\n');
const create = (f: ReturnType<typeof fixture>, body: string, extra: string[] = []) => {
    const file = join(f.dir, 'body.md');
    writeFileSync(file, body);
    return spawnSync(process.execPath, [OPEN, '--repo', f.repo, '--base', 'main', '--title', 'T', '--body-file', file, ...extra], { encoding: 'utf8', env: f.env });
};

test('pr-open expands file tokens after creating the PR, with the checked body', () => {
    const f = fixture();
    const r = create(f, BODY('Start at {{file:src/widgets/alpha.ts}}.'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pull\/7/);
    const calls = readFileSync(f.log, 'utf8').trim().split('\n');
    assert.match(calls[0], /^pr create --draft --assignee @me/);
    assert.equal(calls[1], 'pr view 7 --json url,body,files');
    assert.match(calls[2], /^pr edit 7 --body-file /);
    assert.ok(readFileSync(f.edited, 'utf8').includes(`[src/widgets/alpha.ts](${PR}/files#${diffAnchor('src/widgets/alpha.ts')})`));
});

test('pr-open refuses before creating anything when a token names a path outside the diff', () => {
    const f = fixture();
    const r = create(f, BODY('Start at {{file:src/widgets/missing.ts}}.'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not in the diff: src\/widgets\/missing\.ts/);
    assert.ok(!existsSync(f.log), 'gh must not run');
});

test('a body with no tokens never calls pr view or pr edit', () => {
    const f = fixture();
    assert.equal(create(f, BODY('Plain guide.')).status, 0);
    assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
});

test('pr-guide-links backfills an open PR, is a no-op when nothing is left, and fails loudly on an unknown path', () => {
    const f = fixture();
    const run = () => spawnSync(process.execPath, [LINKS, f.repo, '7'], { encoding: 'utf8', env: f.env });
    assert.equal(run().status, 0);
    assert.ok(readFileSync(f.edited, 'utf8').includes('/files#diff-'));
    writeFileSync(f.view, JSON.stringify({ url: PR, body: readFileSync(f.edited, 'utf8'), files: [{ path: 'src/widgets/alpha.ts' }] }));
    const before = readFileSync(f.log, 'utf8').split('\n').filter((l) => l.startsWith('pr edit')).length;
    assert.equal(run().status, 0);
    assert.equal(readFileSync(f.log, 'utf8').split('\n').filter((l) => l.startsWith('pr edit')).length, before, 'second run writes nothing');
    writeFileSync(f.view, JSON.stringify({ url: PR, body: 'See {{file:nope.ts}}.', files: [{ path: 'src/widgets/alpha.ts' }] }));
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /nope\.ts/);
    assert.equal(spawnSync(process.execPath, [LINKS], { encoding: 'utf8' }).status, 2);
});
