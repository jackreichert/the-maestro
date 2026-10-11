// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/local-review.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordVerdict, localUnitId } from '../../review-verdict.ts';
import { buildLocalReview, verdictState } from './local-review.ts';
import { createWebServer } from './server.ts';

const NOW = new Date('2026-10-11T15:00:00Z');
const tmp = mkdtempSync(join(tmpdir(), 'local-review-'));
const container = join(tmp, 'container');
const ledger = join(tmp, 'ledger');
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
const commit = (cwd: string, file: string): void => { writeFileSync(join(cwd, file), file); sh(cwd, 'add', file); sh(cwd, 'commit', '-q', '-m', `add ${file}`); };

// Fixture: repo "alpha" cloned from a bare origin with staging. Branches: pushed (has a remote branch), local-only ahead, local-only checked out in a worktree, local-only with nothing new, and a protected one.
const origin = join(tmp, 'origin.git');
mkdirSync(container, { recursive: true });
sh(tmp, 'init', '-q', '--bare', '-b', 'staging', origin);
const alpha = join(container, 'alpha');
sh(tmp, 'clone', '-q', origin, alpha);
commit(alpha, 'base.txt');
sh(alpha, 'push', '-q', 'origin', 'staging');
sh(alpha, 'switch', '-q', '-c', 'feat/pushed');
commit(alpha, 'p.txt');
sh(alpha, 'push', '-q', 'origin', 'feat/pushed');
sh(alpha, 'switch', '-q', 'staging');
sh(alpha, 'switch', '-q', '-c', 'feat/local-one');
commit(alpha, 'one.txt');
commit(alpha, 'one-b.txt');
sh(alpha, 'switch', '-q', 'staging');
sh(alpha, 'branch', 'feat/no-new-commits');
sh(alpha, 'worktree', 'add', '-q', '-b', 'feat/in-tree', join(container, '.worktrees-alpha-tree'));
commit(join(container, '.worktrees-alpha-tree'), 'tree.txt');
sh(alpha, 'branch', 'develop');   // a protected name with no new commits: never listed
mkdirSync(join(container, 'not-a-repo'));
// A repo one folder down (like skills/the-maestro) is read too; its folder stays container-relative.
mkdirSync(join(container, 'skills'));
const gamma = join(container, 'skills', 'gamma');
sh(tmp, 'clone', '-q', origin, gamma);
sh(gamma, 'switch', '-q', '-c', 'feat/nested-local');
commit(gamma, 'g.txt');
sh(gamma, 'switch', '-q', 'staging');
mkdirSync(join(ledger, 'Projects', 'p', 'Journal'), { recursive: true });

const build = (): ReturnType<typeof buildLocalReview> => buildLocalReview({ containerRoot: container, vault: ledger, now: NOW });

test('lists only local branches with commits no origin ref has and no remote twin, newest first', () => {
  const r = build();
  assert.equal(r.available, true);
  assert.deepEqual(r.units.map((u) => u.branch).sort(), ['feat/in-tree', 'feat/local-one', 'feat/nested-local']);
  const one = r.units.find((u) => u.branch === 'feat/local-one');
  assert.equal(one?.ahead, 2);
  assert.equal(one?.repo, 'alpha');
  assert.equal(one?.head, sh(alpha, 'rev-parse', 'feat/local-one'));
  assert.equal(one?.subject, 'add one-b.txt');
  assert.equal(one?.base, 'origin/staging');
  assert.equal(one?.id, 'local:alpha#feat/local-one');
});

test('a branch in a worktree points at the worktree; the others at the repo; no path is absolute', () => {
  const r = build();
  const tree = r.units.find((u) => u.branch === 'feat/in-tree');
  assert.equal(tree?.checkedOut, true);
  assert.equal(tree?.where, '.worktrees-alpha-tree');
  assert.equal(r.units.find((u) => u.branch === 'feat/local-one')?.where, 'alpha');
  assert.ok(!JSON.stringify(r).includes(tmp), 'the container path never leaves the server');
  assert.equal(r.units.find((u) => u.branch === 'feat/local-one')?.command, "git -C 'alpha' difftool 'origin/staging...feat/local-one'");
});

test('the verdict follows the head: pass, needs work, then stale after a new commit, never a pass for another head', () => {
  const unit = localUnitId('alpha', 'feat/local-one');
  const head = sh(alpha, 'rev-parse', 'feat/local-one');
  assert.equal(build().units.find((u) => u.id === unit)?.verdict.state, 'none');
  recordVerdict(ledger, { pr: unit, head, verdict: 'SHIP IT', reviewer: 'r', fixer: 'f' });
  assert.equal(build().units.find((u) => u.id === unit)?.verdict.state, 'ship-it');
  recordVerdict(ledger, { pr: unit, head, verdict: 'NEEDS WORK', reviewer: 'r', fixer: 'f' });
  assert.equal(build().units.find((u) => u.id === unit)?.verdict.state, 'needs-work');
  sh(alpha, 'switch', '-q', 'feat/local-one');
  commit(alpha, 'one-c.txt');
  sh(alpha, 'switch', '-q', 'staging');
  const after = build().units.find((u) => u.id === unit);
  assert.equal(after?.verdict.state, 'stale');
  assert.equal(after?.ahead, 3);
});

test('a repo one folder down is scanned: unit id uses its folder name, paths stay container-relative', () => {
  const u = build().units.find((x) => x.branch === 'feat/nested-local');
  assert.equal(u?.id, 'local:gamma#feat/nested-local');
  assert.equal(u?.repo, 'gamma');
  assert.equal(u?.where, 'skills/gamma');
  assert.equal(u?.command, "git -C 'skills/gamma' difftool 'origin/staging...feat/nested-local'");
});

test('verdictState: a row for another unit does not count', () => {
  const row = { pr: 'local:alpha#other', head: 'a'.repeat(40), verdict: 'SHIP IT' as const, reviewer: 'r', fixer: 'f', at: 'x' };
  assert.deepEqual(verdictState([row], 'local:alpha#feat/x', 'a'.repeat(40)), { state: 'none' });
});

test('verdictState: a row recorded with an upper-case sha still matches the lower-case head', () => {
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const row = { pr: 'local:alpha#feat/x', head: head.toUpperCase(), verdict: 'SHIP IT' as const, reviewer: 'r', fixer: 'f', at: 'x' };
  assert.equal(verdictState([row], 'local:alpha#feat/x', head).state, 'ship-it');
});

test('no container configured, or an unreadable one, says why instead of an empty list', () => {
  const none = buildLocalReview({ vault: ledger, now: NOW });
  assert.equal(none.available, false);
  assert.match(none.reason ?? '', /container_root/);
  const bad = buildLocalReview({ containerRoot: join(tmp, 'missing'), vault: ledger, now: NOW });
  assert.equal(bad.available, false);
  assert.match(bad.reason ?? '', /cannot be read/);
});

test('the cap keeps the newest units and counts the rest', () => {
  const r = buildLocalReview({ containerRoot: container, vault: ledger, now: NOW, max: 1 });
  assert.equal(r.units.length, 1);
  assert.equal(r.more, 2);
});

const clientDir = join(tmp, 'client');
mkdirSync(clientDir, { recursive: true });
writeFileSync(join(clientDir, 'index.html'), '<p>x</p>');
const page = { streams: [], repoStreams: {}, vaultName: 'V', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'x^', tz: 'UTC' };
const server = createWebServer({ web: { vault: ledger, project: 'p', statusDir: join(ledger, 'Status'), page, containerRoot: container }, clientDir, now: () => NOW, log: () => {} });
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

test('GET /api/local-review serves the queue as JSON', async () => {
  const body = await new Promise<{ status: number; text: string }>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/local-review', headers: { host: `127.0.0.1:${port}` } }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, text })); });
    req.on('error', fail); req.end();
  });
  assert.equal(body.status, 200);
  const j = JSON.parse(body.text) as { available: boolean; units: { branch: string }[] };
  assert.equal(j.available, true);
  assert.ok(j.units.some((u) => u.branch === 'feat/local-one'));
});
