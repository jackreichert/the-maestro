// Run: node --test scripts/pr-watch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhStub, paged, prNode } from './lib/gh-stub.mjs';

const SCRIPT = new URL('./pr-watch.mjs', import.meta.url).pathname;
const tempState = (content) => {
  const path = join(mkdtempSync(join(tmpdir(), 'pr-watch-test-')), 'state.json');
  if (content) writeFileSync(path, JSON.stringify(content));
  return path;
};

function runOnce(env, state, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, '--once', '--state', state, ...extra], { encoding: 'utf8', env, timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A legacy-format state file: the bare board, which is what the 53 PRs below were baselined as.
const boardOf = (nodes) =>
  Object.fromEntries(nodes.map((n) => [`org/repo#${n.number}`, {
    url: n.url, repo: 'org/repo', number: n.number, isDraft: false, head: n.headRefOid, needsCopilot: false,
    decision: n.reviewDecision || 'NONE', threads: [], replies: [], comments: [], reviews: [],
  }]));

test('PRs past the first search page are not reported as having left the open set', () => {
  const nodes = Array.from({ length: 53 }, (_, i) => prNode(i + 1));
  const env = installGhStub({ pages: paged(nodes), prState: 'MERGED' });
  const r = runOnce(env, tempState(boardOf(nodes)));
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /LEFT-OPEN-SET/);
  assert.match(r.out, /no changes/);
});

const approvedNode = (sha) => prNode(4011, { reviewDecision: 'APPROVED', headRefOid: sha });
const approvedBoard = (sha) => boardOf([approvedNode(sha)]);

/** Launches the watcher without --once and reports whether it exited within `ms`. */
function exitsWithin(env, state, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--state', state], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ exited: false, out }); }, ms);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ exited: true, code, out }); });
  });
}

const reportedState = (sha) => ({ board: approvedBoard(sha), reported: { 'APPROVED-UNMERGED org/repo#4011': sha } });

test('relaunching with an unchanged approved PR keeps running', async () => {
  const env = installGhStub({ pages: [[approvedNode('sha-a')]] });
  const r = await exitsWithin(env, tempState(reportedState('sha-a')), 2500);
  assert.equal(r.exited, false, r.out);
  assert.equal(r.out, '');
});

test('an approved PR the user was never told about wakes the watcher once', async () => {
  const env = installGhStub({ pages: [[approvedNode('sha-a')]] });
  const r = await exitsWithin(env, tempState({ board: approvedBoard('sha-a'), reported: {} }), 5000);
  assert.equal(r.exited, true);
  assert.match(r.out, /APPROVED-UNMERGED org\/repo#4011/);
});

test('a moved head on an approved PR is a changed condition and wakes again', async () => {
  const env = installGhStub({ pages: [[approvedNode('sha-b')]] });
  const r = await exitsWithin(env, tempState(reportedState('sha-a')), 5000);
  assert.equal(r.exited, true);
  assert.match(r.out, /APPROVED-UNMERGED org\/repo#4011/);
});

test('--once on an already-reported approval says no changes but still lists it', () => {
  const env = installGhStub({ pages: [[approvedNode('sha-a')]] });
  const r = runOnce(env, tempState(reportedState('sha-a')));
  assert.match(r.out, /no changes/);
  assert.match(r.out, /APPROVED-UNMERGED org\/repo#4011/);
});

test('a cleared condition is forgotten, so it wakes again when it returns', async () => {
  const state = tempState(reportedState('sha-a'));
  runOnce(installGhStub({ pages: [[prNode(4011)]] }), state);
  const r = await exitsWithin(installGhStub({ pages: [[approvedNode('sha-a')]] }), state, 5000);
  assert.equal(r.exited, true);
  assert.match(r.out, /APPROVED-UNMERGED/);
});

test('--once prints the adaptive cadence line to stderr', () => {
  const env = installGhStub({ pages: [[prNode(1)]] });
  const r = runOnce(env, tempState(boardOf([prNode(1)])));
  assert.match(r.err, /next check in 600s \(steady\)/);
});

test('--interval above the floor pins the cadence and says so', () => {
  const env = installGhStub({ pages: [[prNode(1)]] });
  const r = runOnce(env, tempState(boardOf([prNode(1)])), '--interval', '900');
  assert.match(r.err, /next check in 900s \(pinned by --interval\)/);
});

test('--interval under the floor is raised, with a warning', () => {
  const env = installGhStub({ pages: [[prNode(1)]] });
  const r = runOnce(env, tempState(boardOf([prNode(1)])), '--interval', '120');
  assert.match(r.err, /--interval 120 is below the 300s floor/);
  assert.match(r.err, /next check in 300s \(pinned by --interval \(raised to 300\)\)/);
});

for (const bad of ['0', '-5', 'abc', '']) {
  test(`--interval "${bad}" is a usage error`, () => {
    const env = installGhStub({ pages: [[prNode(1)]] });
    const r = runOnce(env, tempState(boardOf([prNode(1)])), '--interval', bad);
    assert.equal(r.code, 2);
    assert.match(r.err, /--interval needs a positive number/);
  });
}

test('a push is an event: a moved head tightens the cadence for the next tick', () => {
  const moved = [1, 2, 3].map((n) => prNode(n, { headRefOid: 'sha-new' }));
  const env = installGhStub({ pages: [moved] });
  const r = runOnce(env, tempState(boardOf([1, 2, 3].map((n) => prNode(n)))));
  assert.match(r.err, /next check in 300s \(high activity: 3 event/);
});

test('in quiet hours with mode stop the watcher exits and says why', () => {
  const minute = Math.floor(Date.now() / 60000) % 1440;
  const hhmm = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String((m + 1440) % 60).padStart(2, '0')}`;
  const env = { ...installGhStub({ pages: [[prNode(1)]] }), MAESTRO_WATCH_TZ: 'UTC', MAESTRO_WATCH_QUIET_HOURS: `${hhmm(minute - 120)}-${hhmm(minute + 120)}` };
  const r = spawnSync(process.execPath, [SCRIPT, '--state', tempState(boardOf([prNode(1)]))], { encoding: 'utf8', env, timeout: 20000 });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /stopping: quiet hours/);
  assert.match(r.stdout, /^QUIET-HOURS stop until \d\d:\d\d UTC\n$/);
});

test('a quiet stop records stoppedForQuietAt in the state file', () => {
  const minute = Math.floor(Date.now() / 60000) % 1440;
  const hhmm = (m) => `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String((m + 1440) % 60).padStart(2, '0')}`;
  const env = { ...installGhStub({ pages: [[prNode(1)]] }), MAESTRO_WATCH_TZ: 'UTC', MAESTRO_WATCH_QUIET_HOURS: `${hhmm(minute - 120)}-${hhmm(minute + 120)}` };
  const state = tempState(boardOf([prNode(1)]));
  spawnSync(process.execPath, [SCRIPT, '--state', state], { encoding: 'utf8', env, timeout: 20000 });
  const saved = JSON.parse(readFileSync(state, 'utf8'));
  assert.ok(Date.now() - Date.parse(saved.stoppedForQuietAt) < 60000);
  assert.deepEqual(Object.keys(saved.board), ['org/repo#1']);
});

test('attention needed exits 0 with the report on stdout', () => {
  const env = installGhStub({ pages: [[approvedNode('sha-a')]] });
  const r = spawnSync(process.execPath, [SCRIPT, '--state', tempState({ board: approvedBoard('sha-a'), reported: {} })], { encoding: 'utf8', env, timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /APPROVED-UNMERGED/);
});

test('a missing --state is a usage error, exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: installGhStub({ pages: [[]] }), timeout: 20000 });
  assert.equal(r.status, 2);
});
