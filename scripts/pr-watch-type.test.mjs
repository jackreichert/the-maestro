// Run: node --test scripts/pr-watch-type.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prWatch from './event-types/pr-watch.mjs';
import { tick } from './event-loop.mjs';
import { addWatch, loadState } from './lib/watch-registry.mjs';
import { installGhStub, paged, prNode } from './lib/gh-stub.mjs';

const NOON = Date.parse('2026-10-01T12:00:00Z');
const DAY = { quietHours: 'off' };

/** A stubbed-gh world: `serve(config)` swaps what gh answers, `ctx(extra)` builds the check context. */
function world(config) {
  const env = installGhStub(config);
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return {
    env,
    serve: (next) => writeFileSync(env.GH_STUB_CONFIG, JSON.stringify(next)),
    ctx: (extra = {}) => ({ run, config: { ghLogin: 'me', copilotOrgs: [] }, ...extra }),
  };
}
const summaries = (events) => events.map((e) => e.summary);
const approved = (sha, n = 4011) => prNode(n, { reviewDecision: 'APPROVED', headRefOid: sha });
const thread = (id, who = 'rev') => ({ id, isResolved: false, comments: { nodes: [{ author: { login: who }, url: `https://x/${id}` }] }, last: { nodes: [{ id: `c-${id}`, author: { login: who }, url: `https://x/${id}` }] } });

test('validate accepts open-prs and open-prs:baseline only', () => {
  prWatch.validate('open-prs');
  prWatch.validate('open-prs:baseline');
  assert.throws(() => prWatch.validate('somewhere'), /must be "open-prs"/);
});

test('a first check reports nothing already there except unannounced standing conditions', () => {
  const w = world({ pages: [[prNode(1), approved('sha-a')]] });
  const first = prWatch.check('open-prs', w.ctx());
  assert.deepEqual(summaries(prWatch.diff(null, first)), ['APPROVED-UNMERGED org/repo#4011 https://github.com/org/repo/pull/4011']);
});

test('baseline: the first check records the snapshot and says nothing, then later changes still speak', () => {
  const w = world({ pages: [[approved('sha-a')]] });
  const first = prWatch.check('open-prs:baseline', w.ctx());
  assert.deepEqual(prWatch.diff(null, first), []);
  assert.equal(Object.keys(first.board).length, 1);
  w.serve({ pages: [[approved('sha-a', 4011), prNode(2, { reviewThreads: { nodes: [thread('t1')] } })]] });
  const second = prWatch.check('open-prs:baseline', w.ctx({ prev: first }));
  assert.equal(second.silent, false, 'only the first check is silent');
  assert.deepEqual(summaries(prWatch.diff(first, second)), ['THREAD org/repo#2 by rev: https://x/t1']);
});

test('threads, replies, comments, reviews and decision flips are reported; the user and Copilot summaries are not', () => {
  const w = world({ pages: [[prNode(7)]] });
  const first = prWatch.check('open-prs', w.ctx());
  const busy = prNode(7, {
    reviewDecision: 'CHANGES_REQUESTED',
    reviewThreads: { nodes: [thread('t1'), { ...thread('t2', 'me') }, { ...thread('t3'), last: { nodes: [{ id: 'r9', author: { login: 'other' }, url: 'https://x/reply' }] } }] },
    comments: { nodes: [{ id: 'k1', author: { login: 'rev' }, url: 'https://x/k1' }, { id: 'k2', author: { login: 'me' }, url: 'https://x/k2' }] },
    reviews: { nodes: [{ id: 'v1', author: { login: 'rev' }, state: 'APPROVED', body: '', url: 'https://x/v1' }, { id: 'v2', author: { login: 'copilot-pull-request-reviewer' }, state: 'COMMENTED', body: 'summary', url: 'https://x/v2' }, { id: 'v3', author: { login: 'rev' }, state: 'COMMENTED', body: '', url: 'https://x/v3' }] },
  });
  w.serve({ pages: [[busy]] });
  const events = summaries(prWatch.diff(first, prWatch.check('open-prs', w.ctx({ prev: first }))));
  assert.deepEqual(events, [
    'DECISION org/repo#7: REVIEW_REQUIRED -> CHANGES_REQUESTED https://github.com/org/repo/pull/7',
    'THREAD org/repo#7 by rev: https://x/t1',
    'THREAD org/repo#7 by rev: https://x/t3',
    'REPLY org/repo#7 by other: https://x/reply',
    'COMMENT org/repo#7 by rev: https://x/k1',
    'REVIEW org/repo#7 by rev (APPROVED): https://x/v1',
  ]);
});

test('PRs past the first search page are not reported as having left the open set', () => {
  const nodes = Array.from({ length: 53 }, (_, i) => prNode(i + 1));
  const w = world({ pages: paged(nodes), prState: 'MERGED' });
  const first = prWatch.check('open-prs', w.ctx());
  assert.equal(Object.keys(first.board).length, 53);
  const second = prWatch.check('open-prs', w.ctx({ prev: first }));
  assert.deepEqual(prWatch.diff(first, second), []);
});

test('a PR that left the open set is reported only once GitHub confirms it is closed', () => {
  const nodes = [1, 2, 3].map((n) => prNode(n));
  const w = world({ pages: [nodes], prState: 'OPEN' });
  const first = prWatch.check('open-prs', w.ctx());
  w.serve({ pages: [nodes.slice(0, 2)], prState: 'OPEN' });
  assert.deepEqual(prWatch.diff(first, prWatch.check('open-prs', w.ctx({ prev: first }))), [], 'a lagging index is not a merge');
  w.serve({ pages: [nodes.slice(0, 2)], prState: 'MERGED' });
  assert.deepEqual(summaries(prWatch.diff(first, prWatch.check('open-prs', w.ctx({ prev: first })))), ['LEFT-OPEN-SET org/repo#3 (merged or closed) https://github.com/org/repo/pull/3']);
});

test('standing: an approval speaks once, speaks again on a moved head, and again after it clears and returns', () => {
  const w = world({ pages: [[approved('sha-a')]] });
  const step = (prev, node) => { w.serve({ pages: [[node]] }); const next = prWatch.check('open-prs', w.ctx({ prev })); return [next, summaries(prWatch.diff(prev, next))]; };
  const [one, told] = step(prWatch.check('open-prs:baseline', w.ctx()), approved('sha-a'));
  assert.deepEqual(told, [], 'already told by the baseline');
  const [two, moved] = step(one, approved('sha-b'));
  assert.equal(moved.length, 1);
  const [three, quiet] = step(two, approved('sha-b'));
  assert.deepEqual(quiet, []);
  const [four, cleared] = step(three, prNode(4011));
  assert.deepEqual(cleared, ['DECISION org/repo#4011: APPROVED -> REVIEW_REQUIRED https://github.com/org/repo/pull/4011'], 'the flip speaks; the standing line does not');
  const [, returned] = step(four, approved('sha-b'));
  assert.ok(returned.some((l) => l.startsWith('APPROVED-UNMERGED ')), 'the approval is news again');
});

test('a truncated search or a fetch error throws, so the loop keeps the last good snapshot', () => {
  const nodes = Array.from({ length: 53 }, (_, i) => prNode(i + 1));
  const w = world({ pages: paged(nodes) });
  const first = prWatch.check('open-prs', w.ctx());
  w.serve({ pages: paged(nodes.slice(0, 5)), prState: 'OPEN' });
  assert.throws(() => prWatch.check('open-prs', w.ctx({ prev: first })), /skipping tick/);
  w.serve({ pages: paged(nodes), failOnPage: 1 });
  assert.throws(() => prWatch.check('open-prs', w.ctx({ prev: first })), /gh api graphql failed/);
});

test('through the loop: the snapshot lands in the loop state, a failing tick leaves it unchanged, and quiet hours skip the watch', () => {
  const w = world({ pages: [[prNode(1)]] });
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-loop-'));
  const types = { 'pr-watch': prWatch };
  addWatch(dir, { id: 'p', type: 'pr-watch', target: 'open-prs' }, NOON);
  const deps = (now, config = DAY) => ({ dir, types, ctx: w.ctx(), config, now });
  assert.deepEqual(tick(deps(NOON)).events, []);
  const saved = loadState(dir).watches.p;
  assert.deepEqual(Object.keys(saved.state.board), ['org/repo#1']);
  assert.equal(saved.nextDue, NOON + 600 * 1000, 'steady cadence is the old watcher\'s 600s');
  assert.ok(!existsSync(join(dir, 'pr-review-p.json')), 'no second file to fall out of step with the digest');

  w.serve({ pages: [[prNode(1, { reviewThreads: { nodes: [thread('t1')] } })]] });
  const out = tick(deps(NOON + 601000));
  assert.deepEqual(summaries(out.events), ['THREAD org/repo#1 by rev: https://x/t1']);

  w.serve({ pages: [[prNode(1)]], failOnPage: 0 });
  const before = JSON.stringify(loadState(dir).watches.p.state);
  tick(deps(NOON + 2000000));
  assert.equal(JSON.stringify(loadState(dir).watches.p.state), before);

  const midnight = Date.parse('2026-10-01T23:00:00Z');
  const quiet = tick(deps(midnight, { quietHours: '20:00-07:00', tz: 'UTC' }));
  assert.deepEqual(quiet.skipped, ['p']);
});

test('an old pr-review state file is adopted once, so the move into the loop does not replay what it already told', () => {
  const w = world({ pages: [[approved('sha-a'), prNode(2, { reviewThreads: { nodes: [thread('t1')] } })]] });
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-legacy-'));
  const board = (n) => ({ url: `https://github.com/org/repo/pull/${n}`, repo: 'org/repo', number: n, isDraft: false, head: 'sha-a', needsCopilot: false, decision: n === 4011 ? 'APPROVED' : 'REVIEW_REQUIRED', threads: [], replies: [], comments: [], reviews: [] });
  writeFileSync(join(dir, 'pr-review-p.json'), JSON.stringify({ board: { 'org/repo#4011': board(4011), 'org/repo#2': board(2) }, reported: { 'APPROVED-UNMERGED org/repo#4011': 'sha-a' } }));
  const ctx = w.ctx({ dir, watch: { id: 'p' }, prev: { changes: [], standing: [] } });
  const next = prWatch.check('open-prs', ctx);
  assert.deepEqual(summaries(prWatch.diff(ctx.prev, next)), ['THREAD org/repo#2 by rev: https://x/t1']);
  prWatch.retired({ id: 'p' }, { dir });
  assert.ok(!existsSync(join(dir, 'pr-review-p.json')));
});

// Copilot is requested only on drafts whose owner is in copilot_orgs; unset fails closed.
function copilotRequests(copilotOrgs, nodes) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-edit-'));
  const editLog = join(dir, 'edits.log');
  writeFileSync(editLog, '');
  const w = world({ pages: [nodes], editLog });
  prWatch.check('open-prs', w.ctx({ config: { ghLogin: 'me', copilotOrgs } }));
  return readFileSync(editLog, 'utf8').trim().split('\n').filter(Boolean);
}
const draftIn = (number, nameWithOwner) => prNode(number, { isDraft: true, repository: { nameWithOwner } });

test('copilot: an owner outside copilot_orgs is never requested', () => {
  assert.deepEqual(copilotRequests(['Allowed-Org'], [draftIn(1, 'other-user/repo')]), []);
});

test('copilot: an owner inside copilot_orgs is requested, case-insensitively', () => {
  const edits = copilotRequests(['allowed-org', 'second'], [draftIn(2, 'Allowed-Org/repo'), draftIn(3, 'other-user/repo')]);
  assert.deepEqual(edits, ['pr edit 2 --repo Allowed-Org/repo --add-reviewer @copilot']);
});

test('copilot: copilot_orgs unset requests nowhere', () => {
  assert.deepEqual(copilotRequests([], [draftIn(4, 'Allowed-Org/repo')]), []);
});

test('the type keeps the old watcher\'s 300s floor even when the watch asks for less', () => {
  const w = world({ pages: [[prNode(1)]] });
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-floor-'));
  addWatch(dir, { id: 'p', type: 'pr-watch', target: 'open-prs', interval: '60' }, NOON);
  tick({ dir, types: { 'pr-watch': prWatch }, ctx: w.ctx(), config: DAY, now: NOON });
  assert.equal(loadState(dir).watches.p.nextDue, NOON + 300 * 1000);
});
