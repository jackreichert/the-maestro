// Run: node --test scripts/pr-watch-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prWatch from './event-types/pr-watch.ts';
import { tick } from './event-loop.ts';
import { addWatch, loadState } from './lib/watch-registry.ts';
import { installGhStub, paged, prNode } from './lib/gh-stub.ts';
import type { GhStubConfig } from './lib/gh-stub.ts';
import type { CadenceConfig } from './lib/cadence.ts';
import type { CheckContext, Run, Watch, WatchEvent } from './lib/types.ts';

const NOON = Date.parse('2026-10-01T12:00:00Z');
const DAY: CadenceConfig = { quietHours: 'off' };
/** A watch record with just the id that matters to the test. */
const watchNamed = (id: string): Watch => ({ op: 'add', id, type: 'pr-watch', target: 'open-prs', done_when: '', report: '', notify_overnight: false, notify: false, interval: null, created: '', expires: '' });

/** A stubbed-gh world: `serve(config)` swaps what gh answers, `ctx(extra)` builds the check context. */
function world(config: GhStubConfig) {
  const env = installGhStub(config);
  const run: Run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return {
    env,
    serve: (next: GhStubConfig) => writeFileSync(env.GH_STUB_CONFIG ?? '', JSON.stringify(next)),
    ctx: (extra: Partial<CheckContext> = {}): Omit<CheckContext, 'now'> => ({ run, config: { ghLogin: 'me', copilotOrgs: [] }, ...extra }),
  };
}
const summaries = (events: Pick<WatchEvent, 'summary'>[]): string[] => events.map((e) => e.summary);
const approved = (sha: string, n = 4011) => prNode(n, { reviewDecision: 'APPROVED', headRefOid: sha });
const thread = (id: string, who = 'rev') => ({ id, isResolved: false, comments: { nodes: [{ author: { login: who }, url: `https://x/${id}` }] }, last: { nodes: [{ id: `c-${id}`, author: { login: who }, url: `https://x/${id}` }] } });

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
  const step = (prev: prWatch.Snapshot, node: unknown): [prWatch.PrWatchState, string[]] => { w.serve({ pages: [[node]] }); const next = prWatch.check('open-prs', w.ctx({ prev })); return [next, summaries(prWatch.diff(prev, next))]; };
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
  const deps = (now: number, config: CadenceConfig = DAY) => ({ dir, types, ctx: w.ctx(), config, now });
  assert.deepEqual(tick(deps(NOON)).events, []);
  const saved = loadState(dir).watches.p;
  assert.ok(saved && prWatch.hasBoard(saved.state), 'the loop keeps the snapshot as the watch state');
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
  const board = (n: number) => ({ url: `https://github.com/org/repo/pull/${n}`, repo: 'org/repo', number: n, isDraft: false, head: 'sha-a', needsCopilot: false, decision: n === 4011 ? 'APPROVED' : 'REVIEW_REQUIRED', threads: [], replies: [], comments: [], reviews: [] });
  writeFileSync(join(dir, 'pr-review-p.json'), JSON.stringify({ board: { 'org/repo#4011': board(4011), 'org/repo#2': board(2) }, reported: { 'APPROVED-UNMERGED org/repo#4011': 'sha-a' } }));
  const ctx = w.ctx({ dir, watch: watchNamed('p'), prev: { changes: [], standing: [] } });
  const next = prWatch.check('open-prs', ctx);
  assert.deepEqual(summaries(prWatch.diff(ctx.prev, next)), ['THREAD org/repo#2 by rev: https://x/t1']);
  prWatch.retired({ id: 'p' }, { dir });
  assert.ok(!existsSync(join(dir, 'pr-review-p.json')));
});

// Copilot is requested only on drafts whose owner is in copilot_orgs; unset fails closed.
function copilotRequests(copilotOrgs: string[], nodes: unknown[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-edit-'));
  const editLog = join(dir, 'edits.log');
  writeFileSync(editLog, '');
  const w = world({ pages: [nodes], editLog });
  prWatch.check('open-prs', w.ctx({ config: { ghLogin: 'me', copilotOrgs } }));
  return readFileSync(editLog, 'utf8').trim().split('\n').filter(Boolean);
}
const draftIn = (number: number, nameWithOwner: string) => prNode(number, { isDraft: true, repository: { nameWithOwner } });

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

test('a fresh watch never adopts a leftover pr-review file: a baseline stays silent', () => {
  const w = world({ pages: [[approved('sha-a')]] });
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-stale-'));
  writeFileSync(join(dir, 'pr-review-p.json'), JSON.stringify({ board: {}, reported: {} }));
  const first = prWatch.check('open-prs:baseline', w.ctx({ dir, watch: watchNamed('p'), prev: null }));
  assert.deepEqual(prWatch.diff(null, first), []);
});

test('a watch lives 72h by default, not the loop\'s 24h', () => {
  assert.equal(prWatch.defaultTtlMs(), 72 * 3600 * 1000);
});

test('watch_min_interval raises the type floor; quiet mode slow keeps the watch polling at 1800s, stop skips it', () => {
  const w = world({ pages: [[prNode(1)]] });
  const types = { 'pr-watch': prWatch };
  const night = Date.parse('2026-10-01T23:00:00Z');
  const quietCfg = (quietMode: string): CadenceConfig => ({ quietHours: '20:00-07:00', tz: 'UTC', quietMode, minInterval: 900 });
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-slow-'));
  addWatch(dir, { id: 'p', type: 'pr-watch', target: 'open-prs' }, night);
  assert.deepEqual(tick({ dir, types, ctx: w.ctx(), config: quietCfg('stop'), now: night }).skipped, ['p']);
  tick({ dir, types, ctx: w.ctx(), config: quietCfg('slow'), now: night });
  assert.equal(loadState(dir).watches.p.nextDue, night + 1800 * 1000);
  const day = mkdtempSync(join(tmpdir(), 'pr-watch-min-'));
  addWatch(day, { id: 'p', type: 'pr-watch', target: 'open-prs' }, NOON);
  tick({ dir: day, types, ctx: w.ctx(), config: { ...DAY, minInterval: 900 }, now: NOON });
  assert.equal(loadState(day).watches.p.nextDue, NOON + 900 * 1000, 'watch_min_interval 900 beats the 600s base');
});

test('add refuses a second pr-watch watch, under either name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-watch-single-'));
  const script = new URL('./event-loop.ts', import.meta.url).pathname;
  const add = (id: string, type: string) => spawnSync(process.execPath, [script, 'add', '--id', id, '--type', type, '--target', 'open-prs'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir } });
  assert.match(add('a', 'pr-review').stdout, /added a/);
  assert.match(add('b', 'pr-watch').stderr, /watch "a" already runs pr-watch \(as pr-review\)/);
  assert.match(add('c', 'pr-review').stderr, /already runs/);
});

// Merge conflicts: a PR turning CONFLICTING speaks once; GitHub's UNKNOWN (still computing) is never a verdict.
const merge = (mergeable: string, n = 9) => prNode(n, { mergeable, baseRefName: 'develop', headRefName: 'feat/x' });
const CONFLICT_LINE = 'CONFLICT org/repo#9 develop <- feat/x https://github.com/org/repo/pull/9';

/** Serves each state in turn through check/diff, chaining the snapshot the way the loop does; returns the events of every tick. */
function walk(states: (string | null)[], first = prWatch.check('open-prs:baseline', world({ pages: [[merge('MERGEABLE')]] }).ctx())): string[][] {
  const w = world({ pages: [[merge('MERGEABLE')]], prState: 'MERGED' });
  let prev: prWatch.Snapshot = first;
  return states.map((s) => {
    w.serve({ pages: [s === null ? [] : [merge(s)]], prState: 'MERGED' });
    const next = prWatch.check('open-prs', w.ctx({ prev }));
    const lines = summaries(prWatch.diff(prev, next));
    prev = next;
    return lines;
  });
}

test('conflict: a clean PR turning CONFLICTING raises one CONFLICT line with base, head and url', () => {
  assert.deepEqual(walk(['CONFLICTING']), [[CONFLICT_LINE]]);
});

test('conflict: it does not re-fire on later ticks, even when the head moves while still conflicting', () => {
  assert.deepEqual(walk(['CONFLICTING', 'CONFLICTING', 'CONFLICTING']), [[CONFLICT_LINE], [], []]);
});

test('conflict: clearing is a silent reset, and a later conflict speaks again', () => {
  assert.deepEqual(walk(['CONFLICTING', 'MERGEABLE', 'MERGEABLE', 'CONFLICTING']), [[CONFLICT_LINE], [], [], [CONFLICT_LINE]]);
});

test('conflict: UNKNOWN is no change, in either direction, and never a conflict', () => {
  assert.deepEqual(walk(['UNKNOWN', 'UNKNOWN', 'MERGEABLE']), [[], [], []], 'UNKNOWN on a clean PR stays quiet');
  assert.deepEqual(walk(['CONFLICTING', 'UNKNOWN', 'CONFLICTING']), [[CONFLICT_LINE], [], []], 'UNKNOWN between two CONFLICTING ticks is not a fresh transition');
  assert.deepEqual(walk(['CONFLICTING', 'UNKNOWN', 'MERGEABLE', 'UNKNOWN', 'CONFLICTING']), [[CONFLICT_LINE], [], [], [], [CONFLICT_LINE]], 'once cleared, a new conflict speaks');
});

test('conflict: UNKNOWN to CONFLICTING speaks, and a field GitHub did not return counts as UNKNOWN', () => {
  assert.deepEqual(walk(['UNKNOWN', 'CONFLICTING']), [[], [CONFLICT_LINE]]);
  const w = world({ pages: [[{ ...prNode(9), mergeable: undefined }]] });
  const first = prWatch.check('open-prs', w.ctx());
  assert.equal(first.board['org/repo#9']?.mergeable, 'UNKNOWN');
  assert.deepEqual(summaries(prWatch.diff(null, first)), []);
});

test('conflict: a PR that closes while conflicting reports only that it left the open set', () => {
  assert.deepEqual(walk(['CONFLICTING', null]), [[CONFLICT_LINE], ['LEFT-OPEN-SET org/repo#9 (merged or closed) https://github.com/org/repo/pull/9']]);
});

test('conflict: a first check tells a PR already conflicting once; a baseline tells nobody', () => {
  const w = world({ pages: [[merge('CONFLICTING')]] });
  assert.deepEqual(summaries(prWatch.diff(null, prWatch.check('open-prs', w.ctx()))), [CONFLICT_LINE]);
  const base = prWatch.check('open-prs:baseline', w.ctx());
  assert.deepEqual(prWatch.diff(null, base), []);
  assert.deepEqual(summaries(prWatch.diff(base, prWatch.check('open-prs', w.ctx({ prev: base })))), [], 'the baseline already holds it, so the next tick stays quiet');
});

test('conflict: a snapshot saved before this field existed tells an already-conflicting PR once, then goes quiet', () => {
  const w = world({ pages: [[merge('CONFLICTING')]] });
  const { mergeable: _drop, ...old } = prWatch.check('open-prs', world({ pages: [[merge('MERGEABLE')]] }).ctx()).board['org/repo#9'] as prWatch.BoardPr;
  const prev = { board: { 'org/repo#9': old as prWatch.BoardPr }, reported: {} };
  const next = prWatch.check('open-prs', w.ctx({ prev }));
  assert.deepEqual(summaries(prWatch.diff(prev, next)), [CONFLICT_LINE]);
  assert.deepEqual(summaries(prWatch.diff(next, prWatch.check('open-prs', w.ctx({ prev: next })))), []);
});

test('events for a self_review_repos repo are labelled apart from the org ones', () => {
  const mineNode = (n: number, over: Record<string, unknown> = {}) => prNode(n, { repository: { nameWithOwner: 'me/tool' }, url: `https://github.com/me/tool/pull/${n}`, ...over });
  const w = world({ pages: [[prNode(1), mineNode(2)]] });
  const ctx = (prev?: prWatch.PrWatchState) => w.ctx({ prev, config: { ghLogin: 'me', copilotOrgs: [], selfReviewRepos: ['me/*'] } });
  const first = prWatch.check('open-prs:baseline', ctx());
  assert.equal(first.board['me/tool#2']?.selfReview, true);
  assert.equal(first.board['org/repo#1']?.selfReview, false);
  w.serve({ pages: [[prNode(1, { reviewThreads: { nodes: [thread('t1')] } }), mineNode(2, { reviewThreads: { nodes: [thread('t2')] }, reviewDecision: 'APPROVED' })]] });
  const second = prWatch.check('open-prs', ctx(first));
  assert.deepEqual(summaries(prWatch.diff(first, second)).sort(), [
    'THREAD org/repo#1 by rev: https://x/t1',
    '[self-review] APPROVED-UNMERGED me/tool#2 https://github.com/me/tool/pull/2',
    '[self-review] DECISION me/tool#2: REVIEW_REQUIRED -> APPROVED https://github.com/me/tool/pull/2',
    '[self-review] THREAD me/tool#2 by rev: https://x/t2',
  ]);
});

test('with no self_review_repos nothing is labelled', () => {
  const w = world({ pages: [[prNode(1, { repository: { nameWithOwner: 'me/tool' }, reviewThreads: { nodes: [thread('t1')] } })]] });
  const first = prWatch.check('open-prs', w.ctx());
  assert.equal(first.board['me/tool#1']?.selfReview, false);
  assert.deepEqual(summaries(prWatch.diff(null, first)), []);
});

/** A fixture board. No GitHub: these tests call diff and steeringEvent on the snapshot directly. */
function boardPr(over: Partial<prWatch.BoardPr> = {}): prWatch.BoardPr {
  return {
    url: 'https://github.com/org/repo/pull/9', repo: 'org/repo', number: 9, isDraft: false, head: 'sha', headRef: 'feat/x', base: 'develop',
    mergeable: 'MERGEABLE', needsCopilot: false, decision: 'REVIEW_REQUIRED', threads: [], replies: [], comments: [], reviews: [], ...over,
  };
}
const watched = (pr: prWatch.BoardPr): prWatch.PrWatchState => ({ board: { [`org/repo#${pr.number}`]: pr }, reported: {}, left: [], silent: false });
const steerOf = (before: prWatch.Board, next: prWatch.Board) => prWatch.steeringEvent(before, next);

test('steering: a PR that becomes conflicting yields one event naming the conflict and the PR, without a second CONFLICT line', () => {
  const prev = watched(boardPr({ mergeable: 'MERGEABLE' }));
  const next = watched(boardPr({ mergeable: 'CONFLICTING' }));
  const steer = steerOf(prev.board, next.board);
  assert.equal(steer.length, 1);
  assert.match(steer[0].summary, /\bpr 9\b/);
  assert.match(steer[0].summary, /conflict with base/);
  const lines = summaries(prWatch.diff(prev, next));
  assert.equal(lines.filter((l) => /\bCONFLICT\b/.test(l)).length, 1);
  assert.equal(lines.filter((l) => l.includes('STEER pr')).length, 0, 'the CONFLICT line already states the fact');
});

test('steering: an open thread yields one event naming the thread and the PR, without a second THREAD line', () => {
  const prev = watched(boardPr());
  const next = watched(boardPr({ threads: [{ id: 't1', who: 'rev', url: 'https://x/t1' }] }));
  const steer = steerOf(prev.board, next.board);
  assert.equal(steer.length, 1);
  assert.match(steer[0].summary, /\bpr 9\b/);
  assert.match(steer[0].summary, /open review thread/);
  assert.match(steer[0].summary, /https:\/\/x\/t1/);
  const lines = summaries(prWatch.diff(prev, next));
  assert.equal(lines.filter((l) => /\bTHREAD\b/.test(l)).length, 1);
  assert.equal(lines.filter((l) => l.includes('STEER pr')).length, 0, 'the THREAD line already states the fact');
});

test('steering: a failing check yields one event naming the check and the PR', () => {
  const prev = watched(boardPr());
  const next = watched(boardPr({ failingChecks: ['lint'] }));
  const steer = steerOf(prev.board, next.board);
  assert.equal(steer.length, 1);
  assert.match(steer[0].summary, /\bpr 9\b/);
  assert.match(steer[0].summary, /failing check lint/);
  assert.deepEqual(summaries(prWatch.diff(prev, next)), [steer[0].summary]);
});

test('steering: an empty or unchanged board emits no new steering event', () => {
  const empty: prWatch.PrWatchState = { board: {}, reported: {}, left: [], silent: false };
  assert.deepEqual(steerOf(empty.board, empty.board), []);
  assert.deepEqual(prWatch.diff(empty, empty), []);
  const held = watched(boardPr({ mergeable: 'CONFLICTING', failingChecks: ['lint'], threads: [{ id: 't1', who: 'rev', url: 'https://x/t1' }] }));
  assert.deepEqual(steerOf(held.board, held.board), []);
  assert.equal(summaries(prWatch.diff(held, held)).some((l) => l.includes('STEER pr')), false);
});

/** Hands a fixture search node to check. The runner never spawns gh. */
function boardFromFixture(node: unknown): prWatch.PrWatchState {
  const run: Run = (_cmd, args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      assert.match(args.join(' '), /statusCheckRollup \{ state \}/);
      return { status: 0, stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [node] } } }), stderr: '' };
    }
    throw new Error(`fixture must not call GitHub: ${args.join(' ')}`);
  };
  return prWatch.check('open-prs', { run, config: { ghLogin: 'me', copilotOrgs: [], selfReviewRepos: [] } });
}

test('search node: a failing rollup fills failingChecks and steering names that label once', () => {
  const node = prNode(9, { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } });
  const next = boardFromFixture(node);
  assert.deepEqual(next.board['org/repo#9']?.failingChecks, ['FAILURE']);
  const steer = steerOf({}, next.board);
  assert.equal(steer.length, 1);
  assert.match(steer[0].summary, /\bpr 9\b/);
  assert.match(steer[0].summary, /failing check FAILURE/);
});

test('search node: no failing check leaves failingChecks empty and emits no failing-check steering event', () => {
  const node = prNode(9, { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } });
  const next = boardFromFixture(node);
  assert.deepEqual(next.board['org/repo#9']?.failingChecks, []);
  assert.equal(steerOf({}, next.board).some((e) => e.summary.includes('failing check')), false);
});
