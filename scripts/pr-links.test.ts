// Run: node --test scripts/pr-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { diffAnchor, expandTokens, parseAnchor, tokenPaths, tokenProblems } from './pr-links.ts';

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
    assert.ok(r.body.includes(`[src/widgets/alpha.ts](${PR}/changes#${diffAnchor('src/widgets/alpha.ts')})`));
    assert.ok(r.body.includes(`[src/widgets/alpha.ts:42](${PR}/changes#${diffAnchor('src/widgets/alpha.ts')}R42)`));
    assert.ok(r.body.includes('{{file:src/gone.ts}}') && r.body.endsWith('Plain text stays.'));
});

test('diffAnchor matches a known answer from a real private-repo PR link', () => {
    // sha256('packages/teamselect-api/src/utils/partner-api.ts'), the hex in a real .../pull/<n>/changes#diff-<hex>R25-R31 link.
    assert.equal(diffAnchor('packages/teamselect-api/src/utils/partner-api.ts'), 'diff-60c3f13bafde03a49d9d9bae1b582d31f14a82a779a918ddf90d3bd2e29455ea');
});

test('expandTokens writes the verified line anchors: R25, R25-R31 and L10-L12', () => {
    const path = 'src/widgets/alpha.ts';
    const id = diffAnchor(path);
    const r = expandTokens('{{file:src/widgets/alpha.ts#R25}} {{file:src/widgets/alpha.ts#R25-R31}} {{file:src/widgets/alpha.ts#L10-L12}} {{file:src/widgets/alpha.ts#R7-R7}}', PR, [path]);
    assert.equal(r.body, `[${path}:25](${PR}/changes#${id}R25) [${path}:25-31](${PR}/changes#${id}R25-R31) [${path}:10-12](${PR}/changes#${id}L10-L12) [${path}:7](${PR}/changes#${id}R7)`);
    assert.deepEqual(r.invalid, []);
});

test('parseAnchor rejects malformed ranges, a start after the end, mixed sides and line 0, with a message', () => {
    assert.deepEqual(parseAnchor('R25-R31'), { side: 'R', start: 25, end: 31 });
    assert.deepEqual(parseAnchor('L4'), { side: 'L', start: 4, end: 4 });
    assert.match(String(parseAnchor('R31-R25')), /runs backwards/);
    assert.match(String(parseAnchor('R25-L31')), /mixes sides/);
    assert.match(String(parseAnchor('R0')), /line 0/);
    for (const bad of ['', 'R', '25', 'R25-', 'R25-31', 'R25-R', 'r25', 'R-5', 'R25R31', 'R1.5']) assert.match(String(parseAnchor(bad)), /not a line anchor/, bad);
});

test('a malformed anchor is left in the body, reported, and never linked', () => {
    const r = expandTokens('See {{file:src/a.ts#R9-R2}} and {{file:src/a.ts#R1}}.', PR, ['src/a.ts']);
    assert.equal(r.expanded, 1);
    assert.equal(r.invalid.length, 1);
    assert.match(r.invalid[0], /^src\/a\.ts: .*runs backwards/);
    assert.ok(r.body.includes('{{file:src/a.ts#R9-R2}}'));
    assert.deepEqual(tokenProblems('{{file:src/a.ts#R9-R2}} {{file:src/a.ts#R1-R2}} {{file:src/a.ts#}}').length, 2);
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
    assert.ok(readFileSync(f.edited, 'utf8').includes(`[src/widgets/alpha.ts](${PR}/changes#${diffAnchor('src/widgets/alpha.ts')})`));
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
    assert.ok(readFileSync(f.edited, 'utf8').includes('/changes#diff-'));
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

test('paths with spaces or non-ASCII letters link, and an unreadable token refuses before creating', () => {
    const r = expandTokens('See {{file:src/my file.ts}} and {{file:src/café.ts#R3}}.', PR, ['src/my file.ts', 'src/café.ts']);
    assert.equal(r.expanded, 2);
    assert.deepEqual(r.unknown, []);
    const f = fixture();
    mkdirSync(join(f.repo, 'src'), { recursive: true });
    writeFileSync(join(f.repo, 'src/café.ts'), 'export const c = 1;\n');
    git(f.repo, 'add', 'src/café.ts'); git(f.repo, 'commit', '-q', '-m', 'accent');
    writeFileSync(f.view, JSON.stringify({ url: PR, body: '', files: [{ path: 'src/café.ts' }] }));
    assert.equal(create(f, BODY('Start at {{file:src/café.ts}}.')).status, 0, 'a quoted-by-git path still matches');
    const broken = create(fixture(), BODY('Start at {{file:src/widgets/alpha.ts'));
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /could not be read/);
});

test('a PR that opens but cannot expand its links exits 3, not the refusal code', () => {
    const f = fixture();
    writeFileSync(f.view, 'not json');
    const r = create(f, BODY('Start at {{file:src/widgets/alpha.ts}}.'));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /PR is open, but its file links were not expanded/);
});

test('pr-open refuses before creating anything on a malformed anchor, and pr-guide-links writes nothing', () => {
    const f = fixture();
    const r = create(f, BODY('Start at {{file:src/widgets/alpha.ts#R30-R10}}.'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /anchor is malformed: src\/widgets\/alpha\.ts: .*runs backwards/);
    assert.ok(!existsSync(f.log), 'gh must not run');
    const g = fixture();
    writeFileSync(g.view, JSON.stringify({ url: PR, body: 'See {{file:src/widgets/alpha.ts#R1-L2}}.', files: [{ path: 'src/widgets/alpha.ts' }] }));
    const run = spawnSync(process.execPath, [LINKS, g.repo, '7'], { encoding: 'utf8', env: g.env });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /malformed.*mixes sides/);
    assert.ok(!readFileSync(g.log, 'utf8').includes('pr edit'), 'nothing is written');
});

test('pr-open expands a ranged token into the verified /changes#diff-<hex>R<a>-R<b> link', () => {
    const f = fixture();
    assert.equal(create(f, BODY('Start at {{file:src/widgets/alpha.ts#R1-R1}}.')).status, 0);
    assert.ok(readFileSync(f.edited, 'utf8').includes(`[src/widgets/alpha.ts:1](${PR}/changes#${diffAnchor('src/widgets/alpha.ts')}R1)`));
});
