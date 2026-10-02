// Run: node --test scripts/event-types.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRun, tick } from './event-loop.mjs';
import { TYPES } from './event-types/index.mjs';
import * as ghRun from './event-types/gh-run.mjs';
import * as inbox from './event-types/inbox.mjs';
import * as prChecks from './event-types/pr-checks.mjs';
import * as prReview from './event-types/pr-review.mjs';
import { installGhStub, prNode } from './lib/gh-stub.mjs';
import { addWatch, readDigest } from './lib/watch-registry.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const ok = (stdout, status = 0) => ({ status, stdout, stderr: '' });
const checks = (...pairs) => JSON.stringify(pairs.map(([name, bucket]) => ({ name, bucket })));

test('every registered type has check, diff and a playbook, and every type file is registered', () => {
  for (const [name, type] of Object.entries(TYPES)) {
    assert.equal(typeof type.check, 'function', name);
    assert.equal(typeof type.diff, 'function', name);
    assert.ok(existsSync(join(ROOT, 'playbooks', 'event-types', `${name}.md`)), `playbook for ${name}`);
  }
  const files = readdirSync(join(ROOT, 'scripts', 'event-types')).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs');
  assert.deepEqual(files.map((f) => f.replace('.mjs', '')).sort(), Object.keys(TYPES).sort());
});

// pr-checks
test('pr-checks: folds buckets into one state', () => {
  assert.deepEqual(prChecks.summarize([]), { overall: 'none', total: 0, failed: [], settled: false });
  assert.equal(prChecks.summarize([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }]).overall, 'passing');
  assert.equal(prChecks.summarize([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }]).overall, 'pending');
  const failing = prChecks.summarize([{ name: 'z', bucket: 'fail' }, { name: 'b', bucket: 'cancel' }, { name: 'c', bucket: 'pending' }]);
  assert.deepEqual([failing.overall, failing.failed, failing.settled], ['failing', ['b', 'z'], false]);
});

test('pr-checks: check() reads gh, tolerates the pending and failing exit codes, and rejects other failures', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push([cmd, ...args]); return ok(checks(['build', 'pending']), 8); };
  assert.equal(prChecks.check('org/repo#12', { run }).overall, 'pending');
  assert.deepEqual(seen[0], ['gh', 'pr', 'checks', '12', '--repo', 'org/repo', '--json', 'name,bucket']);
  assert.equal(prChecks.check('https://github.com/org/repo/pull/12', { run }).total, 1);
  const noChecks = { status: 1, stdout: '', stderr: "no checks reported on the 'feat' branch" };
  assert.equal(prChecks.check('org/repo#12', { run: () => noChecks }).overall, 'none');
  assert.throws(() => prChecks.check('org/repo#12', { run: () => ({ status: 1, stdout: '', stderr: 'gh: Could not resolve to a PullRequest' }) }), /gh pr checks failed: gh: Could not/);
  assert.throws(() => prChecks.check('org/repo#12', { run: () => ok('', 1) }), /gh pr checks failed/);
  assert.throws(() => prChecks.check('org/repo#12', { run: () => ({ status: 4, stdout: '', stderr: 'auth\nmore' }) }), /gh pr checks failed: auth/);
  assert.throws(() => prChecks.check('nonsense', { run }), /owner\/repo#123/);
});

const state = (pairs) => prChecks.summarize(pairs.map(([name, bucket]) => ({ name, bucket })));
test('pr-checks: diff() fixtures', () => {
  const pending = state([['a', 'pending']]);
  const failing = state([['a', 'fail'], ['b', 'pending']]);
  const passing = state([['a', 'pass'], ['b', 'pass']]);
  assert.deepEqual(prChecks.diff(null, pending), [], 'baseline while pending is silent');
  assert.deepEqual(prChecks.diff(pending, pending), []);
  assert.deepEqual(prChecks.diff(pending, failing), [{ summary: 'CI failing: a' }]);
  assert.deepEqual(prChecks.diff(failing, failing), []);
  assert.deepEqual(prChecks.diff(pending, passing), [{ summary: 'CI passing (2 checks)' }]);
  assert.deepEqual(prChecks.diff(failing, pending), [{ summary: 'CI is pending', actionable: false }]);
  assert.equal(prChecks.diff(null, passing).length, 1, 'already settled on the first look is worth reporting');
  assert.equal(prChecks.diff(failing, state([['a', 'fail'], ['c', 'fail']])).length, 1, 'a different failed set speaks again');
});

test('pr-checks: done_when defaults to settled; passing waits for green', () => {
  const failedSettled = state([['a', 'fail']]);
  assert.equal(prChecks.done(failedSettled, { done_when: '' }), true);
  assert.equal(prChecks.done(failedSettled, { done_when: 'passing' }), false);
  assert.equal(prChecks.done(state([['a', 'pass']]), { done_when: 'passing' }), true);
  assert.equal(prChecks.done(state([['a', 'pending']]), {}), false);
});

// gh-run
test('gh-run: check() and diff() fixtures', () => {
  const view = (o) => ({ run: () => ok(JSON.stringify(o)) });
  const running = ghRun.check('org/repo:99', view({ status: 'in_progress', conclusion: null, name: 'ci' }));
  const finished = ghRun.check('org/repo:99', view({ status: 'completed', conclusion: 'failure', name: 'ci' }));
  assert.deepEqual(running, { status: 'in_progress', conclusion: '', name: 'ci' });
  assert.deepEqual(ghRun.diff(null, running), []);
  assert.deepEqual(ghRun.diff({ ...running, status: 'queued' }, running), [{ summary: 'run "ci" is in_progress', actionable: false }]);
  assert.deepEqual(ghRun.diff(running, finished), [{ summary: 'run "ci" completed: failure' }]);
  assert.equal(ghRun.diff(null, finished).length, 1);
  assert.deepEqual(ghRun.diff(finished, finished), []);
  assert.equal(ghRun.done(finished), true);
  assert.equal(ghRun.done(running), false);
  assert.throws(() => ghRun.check('org/repo', view({})), /owner\/repo:<run id>/);
  assert.throws(() => ghRun.check('org/repo:1', { run: () => ({ status: 1, stdout: '', stderr: 'not found' }) }), /not found/);
});

// inbox
const inboxCtx = (stdout, status = 0) => ({ config: { inboxCommand: ['reader', '--unread'] }, run: () => ok(stdout, status) });
test('inbox: only a count leaves the type, never message text', () => {
  const secret = 'please call me about the thing';
  const first = inbox.check('inbox', inboxCtx(`${secret}\nsecond message\n`));
  assert.equal(JSON.stringify(first).includes('call me'), false);
  assert.deepEqual(inbox.diff(null, first), [{ summary: '2 new message(s) from user' }]);
  const more = inbox.check('inbox', inboxCtx(`${secret}\nsecond message\nthird\n`));
  assert.deepEqual(inbox.diff(first, more), [{ summary: '1 new message(s) from user' }]);
  assert.deepEqual(inbox.diff(more, more), []);
  const cleared = inbox.check('inbox', inboxCtx(''));
  assert.deepEqual(inbox.diff(more, cleared), [], 'reading messages is not an event');
});

test('inbox: identical lines count separately, and a missing or failing command is an error', () => {
  assert.equal(inbox.fingerprints('hi\nhi\n').length, 2);
  assert.equal(new Set(inbox.fingerprints('hi\nhi\n')).size, 2);
  assert.throws(() => inbox.check('inbox', { config: { inboxCommand: [] }, run: () => ok('') }), /inbox_command is not set/);
  assert.throws(() => inbox.check('inbox', inboxCtx('', 3)), /exited 3/);
});

// pr-review
test('pr-review: parseReport and diff() fixtures', () => {
  const report = ['2026-10-01T12:00:00Z 2 change(s):', 'THREAD org/repo#4 by rev: https://x/1', 'APPROVED-UNMERGED org/repo#4 https://x/p', 'noise'].join('\n');
  const parsed = prReview.parseReport(report);
  assert.deepEqual(parsed, { changes: ['THREAD org/repo#4 by rev: https://x/1'], standing: ['APPROVED-UNMERGED org/repo#4 https://x/p'] });
  assert.equal(prReview.diff(null, parsed).length, 2);
  assert.deepEqual(prReview.diff(parsed, { changes: [], standing: parsed.standing }), [], 'a standing condition speaks once');
  assert.deepEqual(prReview.parseReport('no changes\n'), { changes: [], standing: [] });
});

test('pr-review: wraps the real pr-watch --once against a stubbed gh', () => {
  const env = installGhStub({ pages: [[prNode(7)]] });
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-test-'));
  const saved = { PATH: process.env.PATH, GH_STUB_CONFIG: process.env.GH_STUB_CONFIG, L: process.env.MAESTRO_LOCAL_CONFIG, Q: process.env.MAESTRO_WATCH_QUIET_HOURS };
  Object.assign(process.env, { PATH: env.PATH, GH_STUB_CONFIG: env.GH_STUB_CONFIG, MAESTRO_LOCAL_CONFIG: '', MAESTRO_WATCH_QUIET_HOURS: 'off' });
  try {
    const ctx = { run: defaultRun, dir, watch: { id: 'prs' } };
    const first = prReview.check('open-prs', ctx);
    assert.deepEqual(prReview.diff(null, first), []);
    writeFileSync(env.GH_STUB_CONFIG, JSON.stringify({ pages: [[prNode(7, { reviewThreads: { nodes: [{ id: 't1', isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, url: 'https://x/t1' }] }, last: { nodes: [{ id: 'c1', author: { login: 'rev' }, url: 'https://x/t1' }] } }] } })]] }));
    const events = prReview.diff(first, prReview.check('open-prs', ctx));
    assert.deepEqual(events, [{ summary: 'THREAD org/repo#7 by rev: https://x/t1' }]);
  } finally {
    process.env.PATH = saved.PATH;
    for (const [k, v] of [['GH_STUB_CONFIG', saved.GH_STUB_CONFIG], ['MAESTRO_LOCAL_CONFIG', saved.L], ['MAESTRO_WATCH_QUIET_HOURS', saved.Q]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// A dry run of each type through the loop with fixtures: no network, nothing real executed.
test('dry run: each type through tick() emits its fixture event and digests it', () => {
  const NOON = Date.parse('2026-10-01T12:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'dry-run-'));
  let phase = 0;
  const run = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr') return ok(checks(['build', phase ? 'fail' : 'pending']), phase ? 1 : 8);
    if (cmd === 'gh' && args[0] === 'run') return ok(JSON.stringify({ status: phase ? 'completed' : 'queued', conclusion: phase ? 'success' : null, name: 'ci' }));
    if (cmd === 'reader') return ok(phase ? 'hello\n' : '');
    return ok(phase ? 'THREAD org/repo#1 by rev: https://x/t\n' : 'no changes\n');
  };
  const ctx = { run, dir, config: { inboxCommand: ['reader'] } };
  addWatch(dir, { id: 'c', type: 'pr-checks', target: 'org/repo#1' }, NOON);
  addWatch(dir, { id: 'r', type: 'gh-run', target: 'org/repo:5' }, NOON);
  addWatch(dir, { id: 'i', type: 'inbox', target: 'inbox' }, NOON);
  addWatch(dir, { id: 'p', type: 'pr-review', target: 'open-prs' }, NOON);
  const deps = (now) => ({ dir, types: TYPES, ctx, config: { quietHours: 'off' }, now });
  assert.deepEqual(tick(deps(NOON)).events, []);
  phase = 1;
  const { events, retired } = tick(deps(NOON + 300000));
  assert.deepEqual(events.map((e) => e.watch).sort(), ['c', 'i', 'p', 'r']);
  assert.ok(events.every((e) => e.actionable));
  assert.deepEqual(retired.map((r) => r.id).sort(), ['c', 'r']);
  assert.equal(readDigest(dir).length, 4);
});

test('pr-review: retiring or removing the watch deletes its pr-watch state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-retire-'));
  const file = join(dir, 'pr-review-w1.json');
  writeFileSync(file, '{}');
  addWatch(dir, { id: 'w1', type: 'pr-review', target: 'open-prs', ttlMs: 60000 }, 0);
  tick({ dir, types: TYPES, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: { quietHours: 'off' }, now: Date.now() });
  assert.equal(existsSync(file), false);
  prReview.retired({ id: 'never-existed' }, { dir });

  addWatch(dir, { id: 'w2', type: 'pr-review', target: 'open-prs' });
  writeFileSync(join(dir, 'pr-review-w2.json'), '{}');
  const script = new URL('./event-loop.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script, 'remove', 'w2'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir } });
  assert.match(r.stdout, /removed w2/);
  assert.equal(existsSync(join(dir, 'pr-review-w2.json')), false);
});

test('pr-checks: the whole failed set is kept, so a change past the fifth name still speaks', () => {
  const six = (last) => prChecks.summarize(['a', 'b', 'c', 'd', 'e', last].map((name) => ({ name, bucket: 'fail' })));
  assert.equal(six('f').failed.length, 6);
  assert.equal(prChecks.diff(six('f'), six('g')).length, 1);
  assert.match(prChecks.diff(null, six('f'))[0].summary, /a, b, c, d, e and 1 more/);
});
