// Run: node --test scripts/event-types.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRun, tick } from './event-loop.mjs';
import { ALIASES, BUILTIN_TYPES as TYPES, loadTypes } from './event-types/index.ts';
import * as ghRun from './event-types/gh-run.ts';
import * as inbox from './event-types/inbox.ts';
import * as prChecks from './event-types/pr-checks.ts';
import * as prMerged from './event-types/pr-merged.ts';
import * as reminder from './event-types/reminder.ts';
import { installGhStub, prNode } from './lib/gh-stub.ts';
import { addWatch, listWatches, readDigest } from './lib/watch-registry.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const ok = (stdout, status = 0) => ({ status, stdout, stderr: '' });
const checks = (...pairs) => JSON.stringify(pairs.map(([name, bucket]) => ({ name, bucket })));

test('every registered type has check, diff and a playbook, and every type file is registered', () => {
  for (const [name, type] of Object.entries(TYPES)) {
    assert.equal(typeof type.check, 'function', name);
    assert.equal(typeof type.diff, 'function', name);
    assert.ok(existsSync(join(ROOT, 'playbooks', 'event-types', `${name}.md`)), `playbook for ${name}`);
  }
  const files = readdirSync(join(ROOT, 'scripts', 'event-types')).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
  assert.deepEqual(files.map((f) => f.replace('.ts', '')).sort(), Object.keys(TYPES).filter((n) => !(n in ALIASES)).sort());
  for (const [old, current] of Object.entries(ALIASES)) assert.equal(TYPES[old], TYPES[current], `${old} is an alias of ${current}`);
});

// overlay types
const GOOD_TYPE = "export const check = (t) => ({ t });\nexport const diff = (p, n) => (p ? [] : [{ summary: `saw ${n.t}`, actionable: true }]);\nexport const done = () => true;\n";

/** An overlay dir whose event-types/ holds the given { file: content } entries. */
function overlayWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-'));
  mkdirSync(join(dir, 'event-types'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'event-types', name), text);
  return dir;
}

test('overlay types: a .ts type loads too, and one name in both extensions is a duplicate', async () => {
  const overlayDir = overlayWith({ 'typed-wait.ts': GOOD_TYPE, 'typed-wait.md': '# typed-wait\n', 'old-wait.mjs': GOOD_TYPE, 'old-wait.md': '# old-wait\n' });
  const types = await loadTypes({ overlayDir });
  assert.equal(types['typed-wait'].done(), true);
  assert.equal(types['old-wait'].done(), true);
  const both = overlayWith({ 'twin.mjs': GOOD_TYPE, 'twin.ts': GOOD_TYPE, 'twin.md': '# twin\n' });
  await assert.rejects(loadTypes({ overlayDir: both }), /overlay event type twin .*twin\.ts.* duplicates/);
});

test('overlay types: a type in <overlay>/event-types is loaded beside the built-ins and runs through the loop', async () => {
  const overlayDir = overlayWith({ 'my-wait.mjs': GOOD_TYPE, 'my-wait.md': '# my-wait\n' });
  const types = await loadTypes({ overlayDir });
  assert.deepEqual(Object.keys(types).sort(), [...Object.keys(TYPES), 'my-wait'].sort());
  assert.equal(types['my-wait'].check('x').t, 'x');
  assert.equal(types['my-wait'].done(), true);
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  addWatch(dir, { id: 'w1', type: 'my-wait', target: 'x' });
  const { events, retired } = tick({ dir, types, config: { quietHours: 'off' } });
  assert.deepEqual(events.map((e) => [e.watch, e.type, e.summary, e.actionable]), [['w1', 'my-wait', 'saw x', true]]);
  assert.equal(retired.length, 1, 'done() retires the watch');
});

test('check() receives the watch and its previous state, so a type can keep a baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const seen = [];
  const types = { base: { check: (_t, ctx) => { seen.push(ctx.prev); return { first: ctx.prev?.first ?? seen.length }; }, diff: () => [] } };
  addWatch(dir, { id: 'b', type: 'base', target: 'x' });
  const now = Date.now();
  tick({ dir, types, config: { quietHours: 'off' }, now });
  tick({ dir, types, config: { quietHours: 'off' }, now: now + 200 * 1000 });
  assert.deepEqual(seen, [null, { first: 1 }]);
});

test('overlay types: a name that is already a built-in is rejected, naming the file', async () => {
  const overlayDir = overlayWith({ 'inbox.mjs': GOOD_TYPE, 'inbox.md': '# inbox\n' });
  await assert.rejects(loadTypes({ overlayDir }), /overlay event type inbox .*inbox\.mjs.* duplicates/);
});

test('overlay types: a malformed module is rejected (missing diff, bad hook, no playbook, syntax error)', async () => {
  const rejects = (files, re) => assert.rejects(loadTypes({ overlayDir: overlayWith(files) }), re);
  await rejects({ 'a.mjs': 'export const check = () => ({});\n', 'a.md': '#' }, /overlay event type a .*export diff\(\) as a function/);
  await rejects({ 'b.mjs': GOOD_TYPE.replace('export const done = () => true;', 'export const done = true;'), 'b.md': '#' }, /overlay event type b .*done must be a function/);
  await rejects({ 'c.mjs': GOOD_TYPE }, /overlay event type c .*no playbook c\.md/);
  await rejects({ 'd.mjs': 'export const check = (', 'd.md': '#' }, /SyntaxError|Unexpected/);
});

test('overlay types: no overlay, or an overlay without event-types, adds nothing', async () => {
  assert.deepEqual(Object.keys(await loadTypes({})), Object.keys(TYPES));
  assert.deepEqual(Object.keys(await loadTypes({ overlayDir: mkdtempSync(join(tmpdir(), 'overlay-')) })), Object.keys(TYPES));
  assert.deepEqual(Object.keys(await loadTypes({ overlayDir: join(tmpdir(), 'no-such-overlay-dir') })), Object.keys(TYPES));
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

// pr-merged
const prView = (o) => ({ run: () => ok(JSON.stringify({ state: 'OPEN', title: 'fix: retry cap', headRefName: 'fix/ABC-12-retry', baseRefName: 'develop', ...o })) });

test('pr-merged: check() reads the PR and finds tracker keys in the title and branch with the default and a configured pattern', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push([cmd, ...args]); return prView({ title: 'ABC-12 and XYZ-7: retry cap' }).run(); };
  const s = prMerged.check('org/repo#5', { run });
  assert.deepEqual(seen[0], ['gh', 'pr', 'view', '5', '--repo', 'org/repo', '--json', 'state,title,headRefName,baseRefName']);
  assert.deepEqual([s.repo, s.number, s.keys], ['org/repo', '5', ['ABC-12', 'XYZ-7']], 'a key in both title and branch is listed once');
  assert.deepEqual(prMerged.extractKeys(['ABC-12 XYZ-7', 'feat/XYZ-7-x'], '\\bXYZ-\\d+\\b'), ['XYZ-7'], 'the overlay narrows the pattern');
  assert.deepEqual(prMerged.extractKeys(['no keys here', 'lowercase-12', undefined]), []);
  assert.throws(() => prMerged.check('org/repo#5', { run: () => ({ status: 1, stdout: '', stderr: 'gh: not found\nmore' }) }), /gh pr view failed: gh: not found/);
  assert.throws(() => prMerged.check('nonsense', { run }), /owner\/repo#123/);
});

test('pr-merged: diff() names the repo, PR and keys on the merge only, and the watch is done when merged or closed', () => {
  const at = (state, over = {}) => ({ state, repo: 'org/repo', number: '5', title: 'ABC-12: retry cap', head: 'fix/ABC-12-retry', base: 'develop', keys: ['ABC-12'], ...over });
  assert.deepEqual(prMerged.diff(null, at('OPEN')), []);
  assert.deepEqual(prMerged.diff(at('OPEN'), at('OPEN')), []);
  assert.deepEqual(prMerged.diff(at('OPEN'), at('MERGED')), [{ summary: 'MERGED org/repo#5; tracker keys: ABC-12; base develop; branch fix/ABC-12-retry; title "ABC-12: retry cap"' }]);
  assert.match(prMerged.diff(null, at('MERGED', { keys: [] }))[0].summary, /^MERGED org\/repo#5; tracker keys: none;/, 'merged before the first look still speaks');
  assert.deepEqual(prMerged.diff(at('OPEN'), at('CLOSED')), [{ summary: 'CLOSED without merging org/repo#5', actionable: false }]);
  assert.ok(prMerged.diff(null, at('MERGED', { title: `line\nbreak ${'x'.repeat(300)}` }))[0].summary.length < 260, 'an untrusted title is one line and clipped');
  const hostile = prMerged.diff(null, at('MERGED', { title: 'x", tracker keys: HACK-1', head: 'h'.repeat(400) }))[0].summary;
  assert.ok(hostile.length <= 300 && hostile.startsWith('MERGED org/repo#5; tracker keys: ABC-12;'), 'keys survive the digest clip however long the branch is');
  assert.ok(hostile.includes('title "x\\", tracker keys: HACK-1"'), 'a quote in the title is escaped');
  assert.deepEqual(['OPEN', 'MERGED', 'CLOSED'].map((x) => prMerged.done(at(x))), [false, true, true]);
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

// A dry run of each type through the loop with fixtures: no network, nothing real executed.
test('dry run: each type through tick() emits its fixture event and digests it', () => {
  const NOON = Date.parse('2026-10-01T12:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'dry-run-'));
  let phase = 0;
  const run = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr') return ok(checks(['build', phase ? 'fail' : 'pending']), phase ? 1 : 8);
    if (cmd === 'gh' && args[0] === 'run') return ok(JSON.stringify({ status: phase ? 'completed' : 'queued', conclusion: phase ? 'success' : null, name: 'ci' }));
    if (cmd === 'reader') return ok(phase ? 'hello\n' : '');
    if (cmd === 'gh' && args[1] === 'user') return ok('me');
    return ok(JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [prNode(1, phase ? { reviewThreads: { nodes: [{ id: 't', isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, url: 'https://x/t' }] }, last: { nodes: [{ id: 'c', author: { login: 'rev' }, url: 'https://x/t' }] } }] } } : {})] } } }));
  };
  const ctx = { run, dir, config: { inboxCommand: ['reader'] } };
  addWatch(dir, { id: 'c', type: 'pr-checks', target: 'org/repo#1' }, NOON);
  addWatch(dir, { id: 'r', type: 'gh-run', target: 'org/repo:5' }, NOON);
  addWatch(dir, { id: 'i', type: 'inbox', target: 'inbox' }, NOON);
  addWatch(dir, { id: 'p', type: 'pr-watch', target: 'open-prs' }, NOON);
  const deps = (now) => ({ dir, types: TYPES, ctx, config: { quietHours: 'off' }, now });
  assert.deepEqual(tick(deps(NOON)).events, []);
  phase = 1;
  const { events, retired } = tick(deps(NOON + 700000));
  assert.deepEqual(events.map((e) => e.watch).sort(), ['c', 'i', 'p', 'r']);
  assert.ok(events.every((e) => e.actionable));
  assert.deepEqual(retired.map((r) => r.id).sort(), ['c', 'r']);
  assert.equal(readDigest(dir).length, 4);
});

test('pr-review (alias of pr-watch): retiring or removing the watch deletes the state file an older pr-review kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-retire-'));
  const file = join(dir, 'pr-review-w1.json');
  writeFileSync(file, '{}');
  addWatch(dir, { id: 'w1', type: 'pr-review', target: 'open-prs', ttlMs: 60000 }, 0);
  tick({ dir, types: TYPES, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: { quietHours: 'off' }, now: Date.now() });
  assert.equal(existsSync(file), false);
  TYPES['pr-review'].retired({ id: 'never-existed' }, { dir });

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

const T0 = Date.parse('2026-10-03T12:00:00Z');
const REMIND = (extra = {}) => ({ dir: mkdtempSync(join(tmpdir(), 'events-')), types: { reminder }, config: { quietHours: 'off' }, ctx: { run: () => { throw new Error('a reminder must not run commands'); } }, ...extra });

test('reminder: a malformed target or a date that does not exist is refused', () => {
  for (const bad of ['tomorrow', '2026-10-03', '2026-10-03T15:00:00', '2026-10-03T15:00:00+02:00', '2026-10-03 15:00:00Z', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-03T25:00:00Z', '']) {
    assert.throws(() => reminder.parseTarget(bad), /reminder target/, bad);
  }
  assert.equal(reminder.parseTarget('2026-10-03T15:00:00Z'), Date.parse('2026-10-03T15:00:00Z'));
  assert.equal(reminder.parseTarget('2026-10-03T15:00Z'), Date.parse('2026-10-03T15:00:00Z'));
  assert.equal(reminder.parseTarget('2026-10-03T15:00:00.500Z'), Date.parse('2026-10-03T15:00:00.500Z'));
});

test('reminder: a past target is rejected at add, a future one is accepted, and an explicit ttl cannot expire it early', () => {
  assert.throws(() => reminder.validate('2026-10-03T11:59:59Z', { now: T0 }), /in the past/);
  assert.throws(() => reminder.validate('2026-10-03T12:00:00Z', { now: T0 }), /in the past/);
  assert.doesNotThrow(() => reminder.validate('2026-10-03T12:00:01Z', { now: T0 }));
  assert.throws(() => reminder.validate('2026-10-05T12:00:00Z', { now: T0, ttlMs: 3600000 }), /expire the reminder/);
  assert.ok(reminder.defaultTtlMs('2026-10-10T12:00:00Z', T0) > 7 * 24 * 3600 * 1000, 'lives past a target a week out');
});

test('reminder: silent before the target, one actionable event at it, then retired and never again', () => {
  const { dir, types, config, ctx } = REMIND();
  addWatch(dir, { id: 'r', type: 'reminder', target: '2026-10-03T12:10:00Z', report: 'stand up' }, T0);
  const at = (min) => tick({ dir, types, config, ctx, now: T0 + min * 60000 });
  assert.deepEqual(at(0).events, []);
  assert.deepEqual(at(9).events, []);
  const fired = at(11);
  assert.equal(fired.events.length, 1);
  assert.equal(fired.events[0].actionable, true);
  assert.equal(fired.events[0].summary, 'reminder: stand up');
  assert.equal(fired.events[0].report, 'stand up');
  assert.deepEqual(fired.retired, [{ id: 'r', reason: 'done' }]);
  assert.deepEqual(at(60).events, []);
  assert.equal(readDigest(dir).length, 1);
});

test('reminder: quiet hours hold it until morning unless --notify-overnight', () => {
  const night = Date.parse('2026-10-03T22:00:00Z');
  const config = { quietHours: '20:00-07:00', quietMode: 'stop', tz: 'UTC' };
  const { dir, types, ctx } = REMIND();
  addWatch(dir, { id: 'held', type: 'reminder', target: '2026-10-03T22:30:00Z', report: 'a' }, night);
  addWatch(dir, { id: 'through', type: 'reminder', target: '2026-10-03T22:30:00Z', report: 'b', notify_overnight: true }, night);
  const out = tick({ dir, types, config, ctx, now: night + 60 * 60000 });
  assert.deepEqual(out.events.map((e) => e.watch), ['through']);
  assert.deepEqual(out.skipped, ['held']);
  const morning = tick({ dir, types, config, ctx, now: Date.parse('2026-10-04T07:30:00Z') });
  assert.deepEqual(morning.events.map((e) => e.watch), ['held']);
});

test('cli: reminder add refuses a bad or past target and stores a future one with a lifetime past its target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'event-loop.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir },
  });
  const add = (id, target, ...more) => cli('add', '--id', id, '--type', 'reminder', '--target', target, '--report', 'x', ...more);
  assert.equal(add('a', 'soon').status, 2);
  assert.match(add('a', '2020-01-01T00:00:00Z').stderr, /in the past/);
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  assert.equal(add('b', future).status, 0);
  const [watch] = JSON.parse(cli('list', '--json').stdout);
  assert.ok(Date.parse(watch.expires) > Date.parse(future), 'expires after the target');
  assert.equal(add('c', future, '--ttl-hours', '1').status, 2);
});

test('reminder: a notifying reminder sends its text once; one added with --no-notify stays in the digest', () => {
  const { dir, types, config, ctx } = REMIND();
  const sent = [];
  addWatch(dir, { id: 'loud', type: 'reminder', target: '2026-10-03T12:05:00Z', report: 'call back', notify: true }, T0);
  addWatch(dir, { id: 'mute', type: 'reminder', target: '2026-10-03T12:05:00Z', report: 'private', notify: false }, T0);
  const notifyRun = (c, a) => { sent.push(a.at(-1)); return { status: 0 }; };
  tick({ dir, types, config, ctx, now: T0 + 6 * 60000, notifyCommand: ['send'], notifyRun });
  tick({ dir, types, config, ctx, now: T0 + 12 * 60000, notifyCommand: ['send'], notifyRun });
  assert.deepEqual(sent, ['loud: reminder: call back']);
  assert.equal(readDigest(dir).length, 2);
});

test('reminder: one that falls in a quiet weekend is held, not expired, and fires when it ends', () => {
  const friday = Date.parse('2026-10-02T21:00:00Z');
  const config = { quietHours: 'off', quietWeekends: true, tz: 'UTC' };
  const { dir, types, ctx } = REMIND();
  const target = '2026-10-03T10:00:00Z';
  addWatch(dir, { id: 'r', type: 'reminder', target, report: 'weekend', notify: true, ttlMs: reminder.defaultTtlMs(target, friday) }, friday);
  const sent = [];
  const notifyRun = (c, a) => { sent.push(a.at(-1)); return { status: 0 }; };
  const run = (cfg, now) => tick({ dir, types, config: cfg, ctx, now, notifyCommand: ['send'], notifyRun });
  for (let t = friday; t < Date.parse('2026-10-05T00:00:00Z'); t += 3 * 3600 * 1000) run(config, t);
  assert.deepEqual(sent, [], 'nothing fires or expires through the quiet weekend');
  assert.equal(listWatches(dir).length, 1);
  const monday = run({ quietHours: 'off', tz: 'UTC' }, Date.parse('2026-10-05T07:00:00Z'));
  assert.deepEqual(monday.events.map((e) => e.summary), ['reminder: weekend']);
  assert.deepEqual(sent, ['r: reminder: weekend']);
});
