// Run: node --test scripts/pr-ready.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGhStub, prNode } from './lib/gh-stub.ts';

const SCRIPT = fileURLToPath(new URL('./pr-ready.ts', import.meta.url));

const repoWithOrigin = (url: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ready-repo-'));
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  return dir;
};

/** Runs pr-ready.ts against a fake gh that serves `nodes` as the open PRs. */
function run(nodes: unknown[], args: string[], env: NodeJS.ProcessEnv = {}, origin = 'https://github.com/org/a.git') {
  const root = mkdtempSync(join(tmpdir(), 'pr-ready-'));
  const readyLog = join(root, 'ready.log');
  const ledger = join(root, 'ledger');
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', repoWithOrigin(origin), '--pr', '9', '--vault', ledger, ...args], {
    encoding: 'utf8',
    env: { ...installGhStub({ pages: [nodes], readyLog, prView: { headRefName: 'feat/new', baseRefName: 'develop', reviewDecision: '', mergeable: 'MERGEABLE' } }), MAESTRO_REVIEW_QUEUE_CAP: '4', MAESTRO_REVIEW_QUEUE_ORGS: 'org', MAESTRO_SELF_REVIEW_REPOS: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, readyLog, ledger };
}

const waiting = (n: number) => Array.from({ length: n }, (_, i) => prNode(i + 1));
const logged = (readyLog: string): string[] => (existsSync(readyLog) ? readFileSync(readyLog, 'utf8').split('\n').filter(Boolean) : []);

test('with room in the queue the draft is marked ready', () => {
  const r = run(waiting(3), []);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /review queue: 3 of 4 waiting on reviewers/);
  assert.deepEqual(logged(r.readyLog), ['pr ready 9 --repo github.com/org/a']);
});

test('at the cap it refuses with the reading and the way out, and gh pr ready is never called', () => {
  const r = run(waiting(4), []);
  assert.equal(r.code, 1);
  assert.match(r.err, /pr-ready: refused, review queue: 4 of 4 waiting on reviewers \(full\)\. Not marking org\/a ready/);
  assert.match(r.err, /--over-cap "<reason>"/);
  assert.deepEqual(logged(r.readyLog), []);
});

test('18 open PRs of which only 3 wait on reviewers is not over the cap: the author\'s own backlog does not block', () => {
  const backlog = Array.from({ length: 15 }, (_, i) => prNode(100 + i, { reviewDecision: 'CHANGES_REQUESTED' }));
  const r = run([...waiting(3), ...backlog], []);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 of 4 waiting on reviewers · 15 waiting on you/);
});

test('--over-cap marks it ready, prints the reason and appends it to over-cap.jsonl; a dry run logs nothing', () => {
  const dry = run(waiting(6), ['--over-cap', 'hotfix', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /--over-cap "hotfix"/);
  assert.deepEqual(logged(dry.readyLog), [], 'a dry run does not call gh');
  assert.equal(existsSync(join(dry.ledger, 'Projects')), false, 'a dry run does not write the override log');
  const r = run(waiting(6), ['--over-cap', 'hotfix']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(logged(r.readyLog), ['pr ready 9 --repo github.com/org/a']);
  const file = spawnSync('find', [r.ledger, '-name', 'over-cap.jsonl'], { encoding: 'utf8' }).stdout.trim();
  const row = JSON.parse(readFileSync(file, 'utf8').trim()) as { repo: string; pr: number; reason: string; cap: number };
  assert.deepEqual([row.repo, row.pr, row.reason, row.cap], ['org/a', 9, 'hotfix', 4]);
});

test('an unreadable queue refuses rather than reading as empty', () => {
  assert.equal(run([], []).code, 0, 'an empty board has room');
  const broken = run([], [], { MAESTRO_GH_BIN: '/nonexistent/gh-for-test', MAESTRO_GH_BIN_ARGS: '' });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /Treat the queue as full/);
});

test('a personal repo is never gated, even at the cap', () => {
  const r = run(waiting(9), [], {}, 'git@github.com:jackreichert/the-maestro.git');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /review queue cap does not apply to jackreichert\/the-maestro/);
  assert.deepEqual(logged(r.readyLog), ['pr ready 9 --repo github.com/jackreichert/the-maestro']);
});

test('bad usage exits 2: no --pr, a non-number, an empty --over-cap', () => {
  const bad = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } }).status;
  assert.equal(bad('--repo', '.'), 2);
  assert.equal(bad('--repo', '.', '--pr', 'abc'), 2);
  assert.equal(bad('--repo', '.', '--pr', '3', '--over-cap'), 2);
});
